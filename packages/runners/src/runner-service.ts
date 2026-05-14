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
  formatSimpleDiff,
} from "@harness/core";
import { newId, nowIso } from "@harness/storage";
import type { LocalStateService } from "@harness/storage";
import { FileRunner } from "./file-runner.ts";
import { ShellRunner } from "./shell-runner.ts";
import { GitRunner } from "./git-runner.ts";
import { TestRunner } from "./test-runner.ts";
import {
  isWithin,
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

    const details = approval.proposedAction;
    if (!details) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "approval.proposedAction is missing; specify execution details before running",
      );
    }

    // Phase 3 MVP: dependency_install / git_commit / network are blocked
    // (per phase-03 보안/승인 정책). UI should not surface execute for these.
    if (
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

    try {
      switch (approval.actionType) {
        case "file_write":
          await this.runFileWrite({ approval, taskRun, step, details, result });
          break;
        case "shell":
          await this.runShell({ approval, taskRun, step, details, result });
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
      result.finishedAt = nowIso();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
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
      await this.deps.state.setTaskRunStatus(taskRun.id, "blocked");
      // Re-throw so IPC layer maps to HarnessError, but with state already
      // recorded so the UI shows the failure even if the call rejects.
      if (e instanceof RunnerError) throw e;
      throw new RunnerError("RUNNER_EXECUTION_FAILED", message);
    }

    return result;
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
    if (!details.filePatch) {
      throw new RunnerError(
        "RUNNER_EXECUTION_FAILED",
        "file_write requires proposedAction.filePatch",
      );
    }
    if (!isWithin(taskRun.targetDir, resolvePath(taskRun.targetDir, details.filePatch.path))) {
      throw new RunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `File path escapes targetDir: ${details.filePatch.path}`,
      );
    }
    const r = await this.file.run({
      targetDir: taskRun.targetDir,
      patch: details.filePatch,
    });
    result.changedFiles = [r.path];

    const diffArtifact = await this.persistArtifact({
      taskRunId: taskRun.id,
      stepId: step.id,
      kind: "diff",
      title: `diff: ${details.filePatch.path}`,
      content: formatSimpleDiff({
        path: details.filePatch.path,
        before: r.beforeContent ?? undefined,
        after: r.afterContent,
      }),
      summary: `${r.bytesWritten} bytes written to ${r.path}`,
    });
    result.artifactIds.push(diffArtifact.id);
  }

  private async runShell(args: {
    approval: Approval;
    taskRun: TaskRun;
    step: Step;
    details: ProposedActionDetails;
    result: RunnerResult;
  }): Promise<void> {
    const { taskRun, step, details, result } = args;
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
        })
      : await this.shell.run({
          command: details.command,
          cwd: taskRun.targetDir,
          timeoutMs: DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
          idleTimeoutMs: DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
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
}

const mapActionToStepKind = (
  action: string,
): "edit" | "shell" | "test" | "summarize" => {
  switch (action) {
    case "file_write":
      return "edit";
    case "shell":
      return "shell";
    default:
      return "summarize";
  }
};

const summarize = (details: ProposedActionDetails): string => {
  if (details.command) return `shell: ${details.command}`;
  if (details.filePatch) return `file: ${details.filePatch.path}`;
  return details.type;
};

const summarizeStepInput = (
  approval: Approval,
  details: ProposedActionDetails,
): string => {
  if (details.command) return details.command;
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
