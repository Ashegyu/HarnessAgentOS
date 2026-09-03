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
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
  DEFAULT_RUNNER_TEST_TIMEOUT_MS,
  RUNNER_CANCELLED,
  evaluateApprovalActionPolicy,
  formatSimpleDiff,
  validateProposedActionDetails,
} from "@harness/core";
import { newId, nowIso } from "@harness/storage";
import type { LocalStateService } from "@harness/storage";
import { readFile, writeFile } from "node:fs/promises";
import { relative as relativePath, resolve as resolveNodePath } from "node:path";
import { FileRunner } from "./file-runner.ts";
import { ShellRunner } from "./shell-runner.ts";
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

export class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

export interface RunnerServiceDeps {
  state: LocalStateService;
  artifactStore: ArtifactStore;
  fileRunner?: FileRunner;
  shellRunner?: ShellRunner;
  gitRunner?: GitRunner;
  testRunner?: TestRunner;
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
  private readonly git: GitRunner;
  private readonly test: TestRunner;
  private readonly deps: RunnerServiceDeps;
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps: RunnerServiceDeps) {
    this.deps = deps;
    this.file = deps.fileRunner ?? new FileRunner();
    this.shell = deps.shellRunner ?? new ShellRunner();
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
    return this.executeApprovedInternal(approvalId, { allowExecuted: true });
  }

  async executeApproved(approvalId: string): Promise<RunnerResult> {
    return this.executeApprovedInternal(approvalId, { allowExecuted: false });
  }

  async cancelExecution(input: {
    taskRunId: string;
  }): Promise<{ cancelled: boolean }> {
    const controller = this.inflight.get(input.taskRunId);
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  }

  getInflightCount(): number {
    return this.inflight.size;
  }

  private async executeApprovedInternal(
    approvalId: string,
    options: { allowExecuted: boolean },
  ): Promise<RunnerResult> {
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
    const isTestShell =
      approval.actionType === "shell" &&
      typeof details.command === "string" &&
      isTestCommand(details.command);
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
    await this.deps.state.setTaskRunCurrentStep(taskRun.id, step.id);
    await this.deps.state.setTaskRunStatus(taskRun.id, "running");

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
    const controller = new AbortController();
    this.inflight.set(taskRun.id, controller);

    try {
      switch (approval.actionType) {
        case "file_patch":
          await this.runFilePatch({ approval, taskRun, step, details, result });
          break;
        case "file_write":
          await this.runFileWrite({ approval, taskRun, step, details, result });
          break;
        case "shell":
          await this.runShell({
            approval,
            taskRun,
            step,
            details,
            result,
            signal: controller.signal,
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
      const message = e instanceof Error ? e.message : String(e);
      const cancelled = isRunnerCancelled(e);
      const errorCode = e instanceof RunnerError
        ? e.code
        : "RUNNER_EXECUTION_FAILED";
      const errorArtifact = await this.persistArtifact({
        taskRunId: taskRun.id,
        stepId: step.id,
        kind: "log",
        title: `runner error (${approval.actionType})`,
        content: message,
        summary: message.slice(0, 200),
      });
      result.artifactIds.push(errorArtifact.id);
      result.stderr = message;
      result.finishedAt = nowIso();
      await this.deps.state.setStepStatus(step.id, "failed", {
        outputSummary: message.slice(0, 200),
      });
      await this.deps.state.setTaskRunStatus(
        taskRun.id,
        cancelled ? "cancelled" : "blocked",
      );
      if (!cancelled) {
        await this.recordPinnedContextOutcome({
          taskRun,
          approval,
          status: "failed",
          summary: `runner ${approval.actionType} failed (${errorCode})`,
          errorCode,
          errorArtifactId: errorArtifact.id,
        });
      }
      // Re-throw so IPC layer maps to HarnessError, but with state already
      // recorded so the UI shows the failure even if the call rejects.
      if (cancelled) throw new RunnerError(RUNNER_CANCELLED, message);
      if (e instanceof RunnerError) throw e;
      throw new RunnerError("RUNNER_EXECUTION_FAILED", message);
    } finally {
      if (this.inflight.get(taskRun.id) === controller) {
        this.inflight.delete(taskRun.id);
      }
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

    await this.deps.state.setStepStatus(checkpoint.stepId, "succeeded", {
      outputSummary: summarizeResolvedApprovals(checkpointApprovals),
    });
    return checkpointApprovals;
  }

  private async settleTaskRunAfterSuccessfulExecution(
    taskRunId: string,
    checkpointApprovals: Approval[],
  ): Promise<void> {
    await this.deps.state.setTaskRunStatus(
      taskRunId,
      checkpointApprovals.some(isUnresolvedApproval)
        ? "waiting_for_approval"
        : "ready_for_review",
    );
  }

  // -- Runner dispatchers ------------------------------------------------

  private async runFileWrite(args: {
    approval: Approval;
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
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
    const r = await this.file.run({
      targetDir: taskRun.targetDir,
      patch: executionPatch,
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

    // patch 계산 뒤에도 실제 경계를 재확인해 승인 후 junction 교체를 차단한다.
    if (!(await isRealPathWithin(taskRun.targetDir, targetPath))) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `File path resolves outside targetDir: ${patch.path}`,
      );
    }
    await writeFile(targetPath, applied.afterContent, "utf8");
    result.changedFiles = [targetPath];

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
  }): Promise<void> {
    const { taskRun, step, details, result, signal } = args;
    if (!details.command || details.command.trim().length === 0) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "shell requires proposedAction.command",
      );
    }
    const safety = classifyShellCommand(details.command);
    if (safety.dangerous) {
      throw new RunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Shell command refused: ${safety.reason}`,
      );
    }
    // Test invocations route through TestRunner so we can emit a
    // dedicated test_result artifact alongside the raw shell log
    // (Phase 3 mvp-user-flows.md Flow 8).
    const isTest = isTestCommand(details.command);
    const runOutcome = isTest
      ? await this.test.run({
          command: details.command,
          cwd: taskRun.targetDir,
          timeoutMs: DEFAULT_RUNNER_TEST_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
          signal,
        })
      : await this.shell.run({
          command: details.command,
          cwd: taskRun.targetDir,
          timeoutMs: DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
          signal,
        });
    result.exitCode = runOutcome.exitCode;
    result.stdout = maskSecrets(runOutcome.stdout);
    result.stderr = maskSecrets(runOutcome.stderr);

    const logArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "log",
      title: `${isTest ? "test" : "shell"}: ${details.command.slice(0, 64)}`,
      content: formatShellLog(
        runOutcome.stdout,
        runOutcome.stderr,
        runOutcome.exitCode,
      ),
      summary: `exit=${runOutcome.exitCode}, ${runOutcome.durationMs}ms`,
    });
    result.artifactIds.push(logArtifact.id);

    if (isTest) {
      const passed = runOutcome.exitCode === 0;
      const testArtifact = await this.persistArtifact({
        taskRunId: taskRun.id,
        stepId: step.id,
        kind: "test_result",
        title: `test_result: ${details.command.slice(0, 64)}`,
        content: formatTestResult({
          command: details.command,
          exitCode: runOutcome.exitCode,
          durationMs: runOutcome.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
        summary: `exit=${runOutcome.exitCode} ${passed ? "passed" : "failed"}`,
      });
      result.artifactIds.push(testArtifact.id);
    }

    if (runOutcome.exitCode !== 0) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        `Shell command exited with ${runOutcome.exitCode}`,
      );
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
  if (details.command) return `shell: ${details.command}`;
  if (details.unifiedPatch) return `patch: ${details.unifiedPatch.path}`;
  if (details.filePatch) return `file: ${details.filePatch.path}`;
  return details.type;
};

const summarizeStepInput = (
  approval: Approval,
  details: ProposedActionDetails,
): string => {
  if (details.dbSnapshotExport) return details.dbSnapshotExport.targetPath;
  if (details.command) return details.command;
  if (details.unifiedPatch) return details.unifiedPatch.path;
  if (details.filePatch) return details.filePatch.path;
  return approval.actionSummary;
};

const summarizeStepOutput = (r: RunnerResult): string => {
  const bits: string[] = [];
  if (r.exitCode !== undefined) bits.push(`exit=${r.exitCode}`);
  if (r.changedFiles?.length) bits.push(`changed=${r.changedFiles.length}`);
  bits.push(`artifacts=${r.artifactIds.length}`);
  return bits.join(", ");
};

const isUnresolvedApproval = (approval: Pick<Approval, "status">): boolean =>
  approval.status === "pending" ||
  approval.status === "approved" ||
  approval.status === "always_approved_for_run";

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
