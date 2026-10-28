import type {
  ArtifactKind,
  ArtifactStore,
  CreateArtifactInput,
  CreateStepInput,
  ProposedActionDetails,
  Approval,
  Step,
  TaskRun,
} from "@harness/core";
import {
  AsyncWorkScope,
  regressionCheckerId,
  type RegisterRegressionContractInput,
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
  DEFAULT_RUNNER_TEST_TIMEOUT_MS,
  RUNNER_CANCELLED,
  evaluateApprovalActionPolicy,
  taskContractFor,
  taskContractBlocksAction,
  formatSimpleDiff,
  validateProposedActionDetails,
} from "@harness/core";
import { captureValidationRevision, newId, nowIso, resolveValidationWorkspaceKey, type ValidationRevision } from "@harness/storage";
import type { LocalStateService } from "@harness/storage";
import { readFile } from "node:fs/promises";
import { relative as relativePath, resolve as resolveNodePath } from "node:path";
import { FileRunner, FileRunnerError } from "./file-runner.ts";
import { FileDeleteRunner } from "./file-delete-runner.ts";
import { ShellRunner } from "./shell-runner.ts";
import { RegressionContractService } from "./regression-contract-service.ts";
import { GitRunner } from "./git-runner.ts";
import { TestRunner } from "./test-runner.ts";
import {
  applySingleFileUnifiedPatch,
  UnifiedPatchError,
} from "./unified-patch.ts";
import {
  isWithin,
  isRealPathWithin,
  classifyShellCommand,
  isTestCommand,
  maskSecrets,
} from "./runner-policy.ts";
import type { RunnerResult } from "./runner-types.ts";
import { resolveValidationCommand, type ValidationCommandIdentity } from "./validation-command.ts";

interface ShellValidationContext {
  command: ValidationCommandIdentity;
  revision: ValidationRevision;
  generation: number;
  reason?: string;
}

export class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

/** Only a persisted nonzero checker result with unchanged inputs can settle as failed. */
class ValidationProcessFailure extends RunnerError {
  confirmed = false;
  constructor(exitCode: number) { super("RUNNER_EXECUTION_FAILED", `Shell command exited with ${exitCode}`); }
}

export interface RunnerServiceDeps {
  state: LocalStateService;
  artifactStore: ArtifactStore;
  fileRunner?: FileRunner;
  shellRunner?: ShellRunner;
  gitRunner?: GitRunner;
  testRunner?: TestRunner;
  trashItem?: (absolutePath: string) => Promise<void>;
  recordPinnedContextOutcome?: (input: {
    taskRun: TaskRun;
    approval: Approval;
    status: "failed";
    summary: string;
    errorCode: string;
    errorArtifactId: string;
  }) => Promise<unknown>;
}

/**
 * Phase 3 RunnerService. Loads an approved Approval, picks the right
 * runner per actionType, captures result artifacts, and updates Step
 * + TaskRun status. NEVER runs without an approval in `approved` or
 * `always_approved_for_run` state.
 *
 * Source: docs/implementation/phase-03-runner-and-artifacts.md.
 */
export class RunnerService {
  private readonly file: FileRunner;
  private readonly shell: ShellRunner;
  private readonly regressions: RegressionContractService;
  private readonly git: GitRunner;
  private readonly test: TestRunner;
  private readonly deps: RunnerServiceDeps;
  private readonly operations = new AsyncWorkScope(() => new RunnerError(RUNNER_CANCELLED, "Application is shutting down"));
  private shutdownFailure: unknown;
  private readonly inflight = new Map<string, {
    taskRunId: string;
    controller: AbortController;
    finished: Promise<unknown>;
  }>();

  constructor(deps: RunnerServiceDeps) {
    this.deps = deps;
    this.file = deps.fileRunner ?? new FileRunner();
    this.shell = deps.shellRunner ?? new ShellRunner();
    this.regressions = new RegressionContractService(deps.state,this.shell);
    this.git = deps.gitRunner ?? new GitRunner(this.shell);
    this.test = deps.testRunner ?? new TestRunner(this.shell);
  }

  /**
   * Re-run a previously-approved approval after the TaskRun has gone
   * to `blocked` (runner failure) or `quality_failed` (gate failure).
   * Same idempotent path as executeApproved — creates a new step row
   * so previous attempts remain auditable.
   */
  async retryApproval(approvalId: string): Promise<RunnerResult> {
    const approval = await this.deps.state.getApproval(approvalId);
    if (!approval) {
      throw new RunnerError(
        "APPROVAL_NOT_FOUND",
        `Approval ${approvalId} not found`,
      );
    }
    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (!taskRun) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        `TaskRun ${approval.taskRunId} not found`,
      );
    }
    if (
      taskRun.status !== "blocked" &&
      taskRun.status !== "quality_failed"
    ) {
      throw new RunnerError(
        "RUNNER_RETRY_NOT_BLOCKED",
        `Retry is only allowed when TaskRun is blocked or quality_failed (current: ${taskRun.status})`,
      );
    }
    if (approval.retryApprovalId || approval.executionState || approval.status === "executed") {
      throw new RunnerError("APPROVAL_REVIEW_REQUIRED", "이전 실행은 재사용할 수 없습니다. 실제 결과를 검토한 후 새 작업 승인을 생성하세요.");
    }
    return this.executeApproved(approvalId);
  }

  executeApproved(approvalId: string): Promise<RunnerResult> {
    return this.operations.run(() => this.executeApprovedOnce(approvalId));
  }

  registerRegressionContract(input: RegisterRegressionContractInput) {
    return this.operations.run(() => this.regressions.register(input));
  }
  listRegressionContracts(input: { taskRunId: string }) { return this.regressions.list(input.taskRunId); }
  prepareRegressionCheck(input: { taskRunId: string; contractId: string }) {
    return this.operations.run(() => this.regressions.prepare(input.taskRunId,input.contractId));
  }

  async shutdown(): Promise<void> {
    this.operations.seal();
    const approvalIds = [...this.inflight.keys()];
    for (const execution of this.inflight.values()) execution.controller.abort();
    const finished = [...this.inflight.values()].map(execution => execution.finished);
    await this.operations.drain();
    const outcomes = await Promise.all(finished);
    const unconfirmed = outcomes.find(error => errorCodeOf(error) === "RUNNER_TERMINATION_UNCONFIRMED");
    if (unconfirmed) this.shutdownFailure = unconfirmed;
    for (const id of approvalIds) {
      if ((await this.deps.state.getApproval(id))?.executionState === "running") {
        this.shutdownFailure ??= new Error("Runner execution claim could not be finalized; storage remains open");
      }
    }
    if (this.shutdownFailure) throw this.shutdownFailure;
  }

  private async executeApprovedOnce(approvalId: string): Promise<RunnerResult> {
    const approval = await this.deps.state.getApproval(approvalId);
    if (!approval || (approval.status !== "approved" && approval.status !== "always_approved_for_run")) {
      throw new RunnerError("RUNNER_APPROVAL_REQUIRED", "Action is not approved");
    }
    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (taskRun && taskContractBlocksAction(taskContractFor(taskRun), approval.actionType)) {
      throw new RunnerError("TASK_CONTRACT_ACTION_BLOCKED", "읽기 전용 작업 계약에서 실행을 허용하지 않습니다.");
    }
    if (!approval.proposedAction) throw new RunnerError("RUNNER_EXECUTION_FAILED", "approval.proposedAction is missing");
    if (this.operations.closed) throw new RunnerError(RUNNER_CANCELLED, "Application is shutting down");
    const token = newId("step");
    if (this.inflight.has(approvalId)) throw new RunnerError("APPROVAL_CLAIM_LOCKED", "Action is already running");
    const controller = new AbortController();
    let finish!: (error?: unknown) => void;
    const finished = new Promise<unknown>(resolve => { finish = resolve; });
    this.inflight.set(approvalId, { taskRunId: approval.taskRunId, controller, finished });
    let claimed = false;
    let failure: unknown;
    try {
      await this.deps.state.claimApprovalExecution(approvalId, approval.actionRevision ?? 1, token);
      claimed = true;
      const result = await this.executeApprovedInternal(approvalId, { allowExecuted: false }, controller.signal);
      await this.deps.state.finishApprovalExecution(approvalId, token, "succeeded");
      return result;
    } catch (error) {
      failure = error;
      if (claimed) {
        const outcome = error instanceof ValidationProcessFailure && error.confirmed ? "failed" : "uncertain";
        await this.deps.state.finishApprovalExecution(approvalId, token, outcome);
        if (outcome === "failed") await this.closeApprovalStepIfResolved({ taskRunId: approval.taskRunId, checkpointId: approval.checkpointId });
      }
      throw error;
    } finally {
      this.inflight.delete(approvalId);
      finish(failure);
    }
  }

  async cancelExecution(input: {
    taskRunId: string;
  }): Promise<{ cancelled: boolean }> {
    const pending: Promise<unknown>[] = [];
    for (const execution of this.inflight.values()) {
      if (execution.taskRunId !== input.taskRunId) continue;
      execution.controller.abort();
      pending.push(execution.finished);
    }
    const outcomes = await Promise.all(pending);
    const unconfirmed = outcomes.find(error => errorCodeOf(error) === "RUNNER_TERMINATION_UNCONFIRMED");
    if (unconfirmed) throw unconfirmed;
    return { cancelled: pending.length > 0 };
  }

  getInflightCount(): number {
    return this.inflight.size;
  }

  getActiveTaskRunIds(): string[] {
    return [...new Set([...this.inflight.values()].map(execution => execution.taskRunId))];
  }

  private async executeApprovedInternal(
    approvalId: string,
    options: { allowExecuted: boolean },
    signal: AbortSignal,
  ): Promise<RunnerResult> {
    if (signal.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled before start");
    const approval = await this.deps.state.getApproval(approvalId);
    if (!approval) {
      throw new RunnerError("APPROVAL_NOT_FOUND", `Approval ${approvalId} not found`);
    }
    if (
      approval.status !== "approved" &&
      approval.status !== "always_approved_for_run" &&
      !(options.allowExecuted && approval.status === "executed")
    ) {
      throw new RunnerError(
        "RUNNER_APPROVAL_REQUIRED",
        `Approval ${approvalId} is not approved (status=${approval.status})`,
      );
    }

    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (!taskRun) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        `TaskRun ${approval.taskRunId} not found`,
      );
    }

    if (taskContractBlocksAction(taskContractFor(taskRun), approval.actionType)) {
      throw new RunnerError("TASK_CONTRACT_ACTION_BLOCKED", "작업 계약의 읽기 전용 또는 외부 검색 금지 제약으로 이 실행을 허용하지 않습니다.");
    }

    const policy =
      approval.policyEvaluation ?? evaluateApprovalActionPolicy(approval.actionType);
    if (policy.decision === "blocked") {
      throw new RunnerError(
        "RUNNER_POLICY_BLOCKED",
        `Policy blocked ${approval.actionType}: ${policy.reason}`,
      );
    }

    let details = approval.proposedAction;
    if (!details) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "approval.proposedAction is missing; specify execution details before running",
      );
    }

    // Phase 3 MVP: dependency_install / git_commit / network are blocked
    // (per phase-03 보안/승인 정책). capability_use/model_use are also
    // not runner-executed; they only gate prompt/invocation context.
    // UI should not surface execute for these.
    if (
      approval.actionType === "capability_use" ||
      approval.actionType === "model_use" ||
      approval.actionType === "dependency_install" ||
      approval.actionType === "git_commit" ||
      approval.actionType === "network" ||
      approval.actionType === "skill_script" ||
      approval.actionType === "orchestration_plan"
    ) {
      throw new RunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Action type ${approval.actionType} is blocked from MVP runner execution`,
      );
    }

    const detailsValidation = validateProposedActionDetails(
      details,
      approval.actionType,
    );
    if (!detailsValidation.ok || !detailsValidation.details) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        `approval.proposedAction is invalid: ${detailsValidation.reason ?? "unknown validation error"}`,
      );
    }
    details = detailsValidation.details;

    // Find or create a runner Step. shell + a recognised test command
    // surfaces as a "test" step in the timeline so the UI can mark
    // pass/fail at the right granularity (mvp-user-flows Flow 11).
    const shellValidation = approval.actionType === "shell"
      ? await this.prepareShellValidation(details, taskRun.targetDir, taskRun.id, signal)
      : undefined;
    const isTestShell = shellValidation?.command.kinds.includes("test") === true;
    const stepKind = isTestShell
      ? "test"
      : mapActionToStepKind(approval.actionType);
    const stepIndex = (await this.deps.state.listStepsByTaskRun(taskRun.id)).length;
    const stepSummary = summarizeStepInput(approval, details);
    const stepInput: CreateStepInput = {
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: stepKind,
      title: `${stepKind}: ${stepSummary.slice(0, 80)}`,
      status: "running",
      inputSummary: stepSummary.slice(0, 200),
    };
    const step = await this.deps.state.createStep(stepInput);

    const startedAt = nowIso();
    const result: RunnerResult = {
      id: newId("step"),
      taskRunId: taskRun.id,
      stepId: step.id,
      commandSummary: summarize(details),
      artifactIds: [],
      startedAt,
      finishedAt: startedAt,
    };
    let mutationToken: string | undefined;
    try {
      if (signal.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled before side effect");
      await this.deps.state.setTaskRunCurrentStep(taskRun.id, step.id);
      await this.deps.state.setTaskRunStatus(taskRun.id, "running");
      if (signal.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled before side effect");
      if (this.deps.state.workspaceMutations &&
          (approval.actionType !== "shell" || shellValidation?.command.kinds.length === 0)) {
        const workspaceKey = shellValidation?.revision.workspaceKey ?? await resolveValidationWorkspaceKey(taskRun.targetDir);
        mutationToken = await this.deps.state.workspaceMutations.begin(workspaceKey);
      }
      switch (approval.actionType) {
        case "file_delete": {
          if (details.fileDelete) await this.regressions.assertWritable(taskRun.id,taskRun.targetDir,details.fileDelete.path);
          if (!this.deps.trashItem || !details.fileDelete) throw new RunnerError("RUNNER_TRASH_UNAVAILABLE", "휴지통 서비스를 사용할 수 없습니다. 영구 삭제는 하지 않습니다.");
          const deleted = await new FileDeleteRunner(this.deps.trashItem).run(taskRun.targetDir, details.fileDelete);
          result.changedFiles = [deleted.path];
          const artifact = await this.persistArtifact({ taskRunId: taskRun.id, stepId: step.id, kind: "diff",
            title: `deleted: ${details.fileDelete.path}`,
            content: `# File moved to OS recycle bin\n\nPath: ${deleted.path}\nSHA-256: ${details.fileDelete.sha256}\nBytes: ${details.fileDelete.sizeBytes}\nRecovery: operating system Recycle Bin.\n`,
            summary: `Deleted (recycle bin): ${details.fileDelete.path}` });
          result.artifactIds.push(artifact.id);
          break;
        }
        case "file_patch":
          await this.runFilePatch({ approval, taskRun, step, details, result, signal });
          break;
        case "file_write":
          await this.runFileWrite({ approval, taskRun, step, details, result, signal });
          break;
        case "shell":
          await this.runShell({
            approval,
            taskRun,
            step,
            details,
            result,
            signal,
            validation: shellValidation!,
          });
          break;
        default:
          throw new RunnerError(
            "RUNNER_EXECUTION_FAILED",
            `Unsupported actionType: ${approval.actionType}`,
          );
      }

      await this.deps.state.setStepStatus(step.id, "succeeded", {
        outputSummary: summarizeStepOutput(result),
      });
      await this.deps.state.decideApproval(
        approval.id,
        "executed",
        `Executed ${approval.actionType}; artifacts=${result.artifactIds.length}`,
      );
      const approvals = await this.closeApprovalStepIfResolved({
        taskRunId: taskRun.id,
        checkpointId: approval.checkpointId,
      });
      await this.settleTaskRunAfterSuccessfulExecution(taskRun.id, approvals);
      result.finishedAt = nowIso();
    } catch (e) {
      const message = maskSecrets(e instanceof Error ? e.message : String(e));
      const cancelled = isRunnerCancelled(e);
      const errorCode = e instanceof RunnerError || e instanceof FileRunnerError
        ? e.code
        : errorCodeOf(e) === "RUNNER_TERMINATION_UNCONFIRMED"
          ? "RUNNER_TERMINATION_UNCONFIRMED"
        : "RUNNER_EXECUTION_FAILED";
      let errorArtifactId: string | undefined;
      try {
        const errorArtifact = await this.persistArtifact({
          taskRunId: taskRun.id,
          stepId: step.id,
          kind: "log",
          title: `runner error (${approval.actionType})`,
          content: message,
          summary: message.slice(0, 200),
        });
        errorArtifactId = errorArtifact.id;
        result.artifactIds.push(errorArtifact.id);
      } catch {
        // Diagnostic storage is best-effort: preserve the execution error and
        // continue recording failure/cancellation even when artifacts cannot be saved.
      }
      result.stderr = message;
      result.finishedAt = nowIso();
      await this.deps.state.setStepStatus(step.id, "failed", {
        outputSummary: message.slice(0, 200),
      });
      const currentTask = await this.deps.state.getTaskRun(taskRun.id);
      if (currentTask && !["cancelled", "paused"].includes(currentTask.status)) {
        await this.deps.state.setTaskRunStatus(taskRun.id, cancelled ? "cancelled" : "blocked");
      }
      if (!cancelled && errorArtifactId !== undefined) {
        await this.recordPinnedContextOutcome({
          taskRun,
          approval,
          status: "failed",
          summary: `runner ${approval.actionType} failed (${errorCode})`,
          errorCode,
          errorArtifactId,
        });
      }
      // Re-throw so IPC layer maps to HarnessError, but with state already
      // recorded so the UI shows the failure even if the call rejects.
      if (cancelled) throw new RunnerError(RUNNER_CANCELLED, message);
      if (e instanceof RunnerError && e.message === message) throw e;
      throw new RunnerError(errorCode, message);
    } finally {
      if (mutationToken !== undefined) await this.deps.state.workspaceMutations.end(mutationToken);
    }

    return result;
  }

  private async closeApprovalStepIfResolved(input: {
    taskRunId: string;
    checkpointId: string;
  }): Promise<Approval[]> {
    const approvals = await this.deps.state.listApprovalsByTaskRun(
      input.taskRunId,
    );
    const checkpointApprovals = approvals.filter(
      (a) => a.checkpointId === input.checkpointId,
    );
    if (
      checkpointApprovals.length === 0 ||
      checkpointApprovals.some(isUnresolvedApproval)
    ) {
      return checkpointApprovals;
    }

    const checkpoints = await this.deps.state.listCheckpointsByTaskRun(
      input.taskRunId,
    );
    const checkpoint = checkpoints.find((c) => c.id === input.checkpointId);
    if (!checkpoint) return approvals;

    await this.deps.state.setStepStatus(checkpoint.stepId, checkpointApprovals.some(a => a.executionState === "failed") ? "failed" : "succeeded", {
      outputSummary: summarizeResolvedApprovals(checkpointApprovals),
    });
    return checkpointApprovals;
  }

  private async settleTaskRunAfterSuccessfulExecution(
    taskRunId: string,
    _checkpointApprovals: Approval[],
  ): Promise<void> {
    const current = await this.deps.state.getTaskRun(taskRunId);
    if (!current || ["cancelled", "paused", "done"].includes(current.status)) return;
    const approvals = await this.deps.state.listApprovalsByTaskRun(taskRunId);
    await this.deps.state.setTaskRunStatus(
      taskRunId,
      approvals.some(isUnresolvedApproval)
        ? "waiting_for_approval"
        : "ready_for_review",
    );
  }

  // -- Runner dispatchers ------------------------------------------------

  private async prepareShellValidation(details: ProposedActionDetails, cwd: string, taskRunId: string, signal?: AbortSignal): Promise<ShellValidationContext> {
    const workspaceKey = await resolveValidationWorkspaceKey(cwd);
    const before = await this.workspaceEpoch(workspaceKey);
    const revision = this.deps.state.validationRuns && this.deps.state.workspaceMutations
      ? await this.captureRevision(cwd,taskRunId,signal)
      : { workspaceKey, fingerprint: null, reason: "Execution ledger is unavailable" };
    // Resolve scripts inside the captured interval. A script changed before
    // actual execution cannot retain the old checker identity.
    const command: ValidationCommandIdentity = details.regressionCheck
      ? { checkerId: regressionCheckerId(details.regressionCheck.contractId), kinds: ["test"] }
      : await resolveValidationCommand({ command: details.command ?? "", args: details.args, cwd });
    const after = await this.workspaceEpoch(workspaceKey);
    const changed = before.generation !== after.generation || before.activeMutations !== 0 || after.activeMutations !== 0;
    return { command, revision: changed ? { ...revision, fingerprint: null } : revision,
      generation: before.generation,
      ...(changed ? { reason: "Workspace mutation changed during checker preparation" }
        : revision.reason ? { reason: revision.reason } : command.reason ? { reason: command.reason } : {}),
    };
  }

  private workspaceEpoch(workspaceKey: string): Promise<{ generation: number; activeMutations: number }> {
    return this.deps.state.workspaceMutations?.get(workspaceKey) ?? Promise.resolve({ generation: 0, activeMutations: 0 });
  }

  private async captureRevision(cwd: string,taskRunId: string,signal?: AbortSignal): Promise<ValidationRevision> {
    const additionalPaths = await this.deps.state.regressionContracts?.inputPaths(taskRunId) ?? [];
    return captureValidationRevision(cwd,{signal,additionalPaths});
  }

  private async runFileWrite(args: {
    approval: Approval;
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
    signal: AbortSignal;
  }): Promise<void> {
    const { taskRun, step, details, result } = args;
    if (details.dbSnapshotExport) {
      await this.runDbSnapshotExport({ taskRun, step, details, result });
      return;
    }
    if (!details.filePatch) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "file_write requires proposedAction.filePatch",
      );
    }
    const executionPatch = {
      ...details.filePatch,
      path: normalizeFilePatchPath(taskRun.targetDir, details.filePatch.path),
    };
    if (!isWithin(taskRun.targetDir, resolvePath(taskRun.targetDir, executionPatch.path))) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes targetDir: ${details.filePatch.path}`,
      );
    }
    await this.regressions.assertWritable(taskRun.id,taskRun.targetDir,executionPatch.path,executionPatch.after);
    const r = await this.file.run({
      targetDir: taskRun.targetDir,
      patch: executionPatch,
      signal: args.signal,
    });
    result.changedFiles = [r.path];

    const diffArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "diff",
      title: `diff: ${executionPatch.path}`,
      content: formatSimpleDiff({
        path: executionPatch.path,
        before: r.beforeContent ?? undefined,
        after: r.afterContent,
      }),
      summary: `${r.bytesWritten} bytes written to ${r.path}`,
    });
    result.artifactIds.push(diffArtifact.id);
  }

  private async runFilePatch(args: {
    approval: Approval;
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
    signal: AbortSignal;
  }): Promise<void> {
    const { taskRun, step, details, result } = args;
    const patch = details.unifiedPatch;
    if (!patch) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "file_patch requires proposedAction.unifiedPatch",
      );
    }
    const executionPatch = {
      ...patch,
      path: normalizeFilePatchPath(taskRun.targetDir, patch.path),
    };
    const targetPath = resolvePath(taskRun.targetDir, executionPatch.path);
    if (!isWithin(taskRun.targetDir, targetPath)) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes targetDir: ${patch.path}`,
      );
    }
    if (!(await isRealPathWithin(taskRun.targetDir, targetPath))) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `File path resolves outside targetDir: ${patch.path}`,
      );
    }
    let before: string;
    try {
      before = await readFile(targetPath, "utf8");
    } catch {
      throw new RunnerError(
        "RUNNER_PATCH_CONTEXT_MISMATCH",
        `file_patch target does not exist: ${patch.path}`,
      );
    }

    let applied: ReturnType<typeof applySingleFileUnifiedPatch>;
    try {
      applied = applySingleFileUnifiedPatch({
        path: executionPatch.path,
        patch: executionPatch.patch,
        currentContent: before,
      });
    } catch (e) {
      if (e instanceof UnifiedPatchError) {
        throw new RunnerError(e.code, e.message);
      }
      throw e;
    }

    // FileRunner owns write/patch serialization and rechecks this exact
    // preimage while holding canonical file ownership.
    await this.regressions.assertWritable(taskRun.id,taskRun.targetDir,executionPatch.path,applied.afterContent);
    const written = await this.file.run({
      targetDir: taskRun.targetDir,
      patch: { path: executionPatch.path, before, after: applied.afterContent },
      signal: args.signal,
    });
    result.changedFiles = [written.path];

    const diffArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "diff",
      title: `patch: ${executionPatch.path}`,
      content: applied.normalizedPatch,
      summary: `patch applied to ${targetPath}`,
    });
    result.artifactIds.push(diffArtifact.id);
  }

  private async runDbSnapshotExport(args: {
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
  }): Promise<void> {
    const { taskRun, step, details, result } = args;
    const targetPath = details.dbSnapshotExport?.targetPath;
    if (!targetPath) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "db snapshot export requires proposedAction.dbSnapshotExport.targetPath",
      );
    }
    if (!isWithin(taskRun.targetDir, targetPath)) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `Snapshot path escapes targetDir: ${targetPath}`,
      );
    }
    if (!(await isRealPathWithin(taskRun.targetDir, targetPath))) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `Snapshot path resolves outside targetDir: ${targetPath}`,
      );
    }
    await this.regressions.assertWritable(taskRun.id,taskRun.targetDir,targetPath);
    await this.deps.state.writeDbSnapshot(targetPath);
    result.changedFiles = [targetPath];

    const snapshotArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "snapshot",
      title: `db snapshot: ${targetPath}`,
      content: `SQLite database snapshot exported to ${targetPath}`,
      summary: `snapshot written to ${targetPath}`,
    });
    result.artifactIds.push(snapshotArtifact.id);
  }

  private async runShell(args: {
    approval: Approval;
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
    signal?: AbortSignal;
    validation: ShellValidationContext;
  }): Promise<void> {
    const { approval, taskRun, step, details, result, signal, validation } = args;
    if (!details.command || details.command.trim().length === 0) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "shell requires proposedAction.command",
      );
    }
    const commandDisplay = formatProposedCommand(details)!;
    const safety = classifyShellCommand(commandDisplay);
    if (safety.dangerous) {
      throw new RunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Shell command refused: ${safety.reason}`,
      );
    }
    const isTest = validation.command.kinds.includes("test");
    // Keep the existing test timeout for custom wrappers without granting checker evidence.
    const useTestRunner = isTest || isTestCommand(commandDisplay);
    if (signal?.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled before checker start");
    const run = this.deps.state.validationRuns ? await this.deps.state.validationRuns.begin({
      taskRunId: taskRun.id, stepId: step.id, approvalId: approval.id,
      workspaceKey: validation.revision.workspaceKey, checkerId: validation.command.checkerId,
      kinds: validation.command.kinds, startFingerprint: validation.revision.fingerprint,
      startGeneration: validation.generation, ...(validation.reason ? { reason: validation.reason } : {}),
    }) : undefined;
    let runOutcome: Awaited<ReturnType<ShellRunner["run"]>> | undefined;
    let proofArtifactId: string | undefined;
    let failed = false;
    let failure: unknown;
    try {
      if (signal?.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled before checker process");
      runOutcome = details.regressionCheck
        ? await this.regressions.execute(taskRun.id,taskRun.targetDir,details.regressionCheck,signal)
        : useTestRunner ? await this.test.run({
          command: details.command,
          ...(details.args !== undefined ? { args: details.args } : {}),
          cwd: taskRun.targetDir,
          timeoutMs: DEFAULT_RUNNER_TEST_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
          signal,
        }) : await this.shell.run({
          command: details.command,
          ...(details.args !== undefined ? { args: details.args } : {}),
          cwd: taskRun.targetDir,
          timeoutMs: DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
          signal,
        });
      result.exitCode = runOutcome.exitCode;
      result.stdout = maskSecrets(runOutcome.stdout);
      result.stderr = maskSecrets(runOutcome.stderr);
      const regressionSummary = details.regressionCheck
        ? [...runOutcome.stdout.matchAll(/^(reference|candidate): exit=(-?\d+)$/gm)].map(match => match[0]).join("; ") : "";

      const logArtifact = await this.persistArtifact({
        taskRunId: taskRun.id, stepId: step.id, kind: "log",
        title: `${isTest ? "test" : "shell"}: ${commandDisplay.slice(0, 64)}`,
        content: formatShellLog(result.stdout, result.stderr, runOutcome.exitCode),
        summary: `${regressionSummary} exit=${runOutcome.exitCode}, ${runOutcome.durationMs}ms`,
      });
      result.artifactIds.push(logArtifact.id);
      proofArtifactId = logArtifact.id;

      if (isTest) {
        const passed = runOutcome.exitCode === 0;
        const testArtifact = await this.persistArtifact({
          taskRunId: taskRun.id, stepId: step.id, kind: "test_result",
          title: `test_result: ${commandDisplay.slice(0, 64)}`,
          content: formatTestResult({ command: commandDisplay, exitCode: runOutcome.exitCode,
            durationMs: runOutcome.durationMs, stdout: result.stdout, stderr: result.stderr }),
          summary: `${regressionSummary} exit=${runOutcome.exitCode} ${passed ? "passed" : "failed"}`,
        });
        result.artifactIds.push(testArtifact.id);
        proofArtifactId = testArtifact.id;
      }

      if (signal?.aborted) throw new RunnerError(RUNNER_CANCELLED, "Execution cancelled after checker process");
      if (runOutcome.exitCode !== 0) throw new ValidationProcessFailure(runOutcome.exitCode);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      if (run) {
        const finished = await this.captureRevision(taskRun.targetDir,taskRun.id,signal);
        const command = signal?.aborted || details.regressionCheck ? validation.command : await resolveValidationCommand({ command: details.command, args: details.args, cwd: taskRun.targetDir });
        const epoch = await this.workspaceEpoch(validation.revision.workspaceKey);
        const identityChanged = command.checkerId !== validation.command.checkerId;
        const inputChanged = finished.workspaceKey !== validation.revision.workspaceKey ||
          finished.fingerprint !== validation.revision.fingerprint;
        const mutationChanged = epoch.generation !== validation.generation || epoch.activeMutations !== 0;
        const reason = identityChanged ? "Checker identity changed during execution"
          : mutationChanged ? "Workspace generation or active mutation changed during execution"
          : inputChanged ? "Workspace input revision changed during execution"
          : finished.reason ?? validation.reason;
        await this.deps.state.validationRuns.finish(run.id, {
          status: failed ? isRunnerCancelled(failure) || signal?.aborted ? "cancelled" : "failed" : "completed",
          ...(runOutcome ? { exitCode: runOutcome.exitCode } : {}),
          ...(proofArtifactId ? { artifactId: proofArtifactId } : {}),
          finishFingerprint: identityChanged || epoch.activeMutations !== 0 || (details.regressionCheck && !runOutcome) ? null : finished.fingerprint,
          finishGeneration: epoch.generation,
          ...(reason ? { reason } : {}),
        });
        if (failure instanceof ValidationProcessFailure && !signal?.aborted && proofArtifactId &&
            validation.command.kinds.length > 0 && validation.revision.fingerprint !== null &&
            !identityChanged && !inputChanged && !mutationChanged && !reason) {
          failure.confirmed = true;
        }
      }
    }
  }

  // -- Artifact persistence ---------------------------------------------

  private async persistArtifact(input: {
    taskRunId: string;
    stepId: string;
    kind: ArtifactKind;
    title: string;
    content: string;
    summary?: string;
  }): Promise<{ id: string; uri: string }> {
    const artifactId = newId("artifact");
    const written = await this.deps.artifactStore.write({
      taskRunId: input.taskRunId,
      artifactId,
      kind: input.kind,
      content: input.content,
    });
    const dbInput: CreateArtifactInput = {
      id: artifactId,
      taskRunId: input.taskRunId,
      stepId: input.stepId,
      kind: input.kind,
      title: input.title,
      uri: written.uri,
    };
    if (input.summary !== undefined) dbInput.summary = input.summary;
    const stored = await this.deps.state.createArtifact(dbInput);
    return { id: stored.id, uri: stored.uri };
  }

  private async recordPinnedContextOutcome(input: {
    taskRun: TaskRun;
    approval: Approval;
    status: "failed";
    summary: string;
    errorCode: string;
    errorArtifactId: string;
  }): Promise<void> {
    if (!this.deps.recordPinnedContextOutcome) return;
    try {
      await this.deps.recordPinnedContextOutcome(input);
    } catch {
      // Context outcome tracking is advisory and must not affect runner state.
    }
  }
}

const mapActionToStepKind = (
  action: string,
): "edit" | "shell" | "test" | "summarize" => {
  switch (action) {
    case "file_patch":
    case "file_write":
    case "file_delete":
      return "edit";
    case "shell":
      return "shell";
    default:
      return "summarize";
  }
};

const summarize = (details: ProposedActionDetails): string => {
  if (details.dbSnapshotExport) {
    return `db snapshot: ${details.dbSnapshotExport.targetPath}`;
  }
  const command = formatProposedCommand(details);
  if (command) return `shell: ${command}`;
  if (details.unifiedPatch) return `patch: ${details.unifiedPatch.path}`;
  if (details.filePatch) return `file: ${details.filePatch.path}`;
  if (details.fileDelete) return `delete: ${details.fileDelete.path}`;
  return details.type;
};

const summarizeStepInput = (
  approval: Approval,
  details: ProposedActionDetails,
): string => {
  if (details.dbSnapshotExport) return details.dbSnapshotExport.targetPath;
  const command = formatProposedCommand(details);
  if (command) return command;
  if (details.unifiedPatch) return details.unifiedPatch.path;
  if (details.filePatch) return details.filePatch.path;
  if (details.fileDelete) return details.fileDelete.path;
  return approval.actionSummary;
};

const formatProposedCommand = (
  details: ProposedActionDetails,
): string | undefined => {
  if (!details.command) return undefined;
  return details.args === undefined || details.args.length === 0
    ? details.command
    : [details.command, ...details.args].join(" ");
};

const summarizeStepOutput = (r: RunnerResult): string => {
  const bits: string[] = [];
  if (r.exitCode !== undefined) bits.push(`exit=${r.exitCode}`);
  if (r.changedFiles?.length) bits.push(`changed=${r.changedFiles.length}`);
  bits.push(`artifacts=${r.artifactIds.length}`);
  return bits.join(", ");
};

const isUnresolvedApproval = (approval: Pick<Approval, "status" | "retryApprovalId">): boolean =>
  !approval.retryApprovalId && (approval.status === "pending" ||
  approval.status === "approved" ||
  approval.status === "always_approved_for_run");

const errorCodeOf = (e: unknown): string | undefined =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;

const isRunnerCancelled = (e: unknown): boolean =>
  errorCodeOf(e) === RUNNER_CANCELLED;

const summarizeResolvedApprovals = (
  approvals: readonly Pick<Approval, "status">[],
): string => {
  const executed = approvals.filter((a) => a.status === "executed").length;
  const rejected = approvals.filter((a) => a.status === "rejected").length;
  const parts = [`executed=${executed}`];
  if (rejected > 0) parts.push(`rejected=${rejected}`);
  parts.push(`total=${approvals.length}`);
  return `action approvals resolved; ${parts.join(", ")}`;
};

const formatShellLog = (
  stdout: string,
  stderr: string,
  exitCode: number,
): string => {
  const sections = [
    `# exit=${exitCode}`,
    "",
    "## stdout",
    "",
    stdout || "(empty)",
    "",
    "## stderr",
    "",
    stderr || "(empty)",
  ];
  return sections.join("\n");
};

const formatTestResult = (input: {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}): string => {
  const passed = input.exitCode === 0;
  return [
    `# test_result`,
    "",
    `**command**: \`${input.command}\``,
    `**exit**=${input.exitCode} (${passed ? "passed" : "failed"})`,
    `**duration**=${input.durationMs}ms`,
    "",
    `## stdout`,
    "",
    input.stdout || "(empty)",
    "",
    `## stderr`,
    "",
    input.stderr || "(empty)",
  ].join("\n");
};

const resolvePath = (cwd: string, p: string): string => {
  // Avoid pulling node:path into core for resolve; runner-policy.isWithin
  // does its own resolve. Here we just normalize relative paths with a
  // cwd join. Simple concatenation is sufficient for containment check.
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)) return p;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${p}` : `${cwd}${sep}${p}`;
};

const normalizeFilePatchPath = (targetDir: string, patchPath: string): string => {
  const cwdResolved = resolveNodePath(process.cwd(), patchPath);
  if (!isWithin(targetDir, cwdResolved)) {
    return patchPath;
  }
  const targetResolved = resolveNodePath(targetDir, patchPath);
  if (targetResolved === cwdResolved) {
    return patchPath;
  }
  const relativeToTarget = relativePath(targetDir, cwdResolved);
  return relativeToTarget.length > 0 ? relativeToTarget : patchPath;
};
