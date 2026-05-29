import type {
  Approval,
  CodeChangeAttemptResult,
  CodeChangeAttemptStatus,
  CodeChangeLoopRunInput,
  CodeChangeNextAction,
  CodeChangeVerificationResult,
  TaskRunStatus,
} from "@harness/core";
import { newId, type LocalStateService } from "@harness/storage";
export type {
  CodeChangeAttemptResult,
  CodeChangeAttemptStatus,
  CodeChangeLoopRunInput,
  CodeChangeNextAction,
  CodeChangeVerificationResult,
} from "@harness/core";

export interface CodeChangeRunnerResult {
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
}

export interface CodeChangeRunnerExecutor {
  executeApproved(approvalId: string): Promise<CodeChangeRunnerResult>;
}

export interface CodeChangeLoopServiceDeps {
  state: LocalStateService;
  runner: CodeChangeRunnerExecutor;
  now?: () => string;
}

export class CodeChangeLoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodeChangeLoopError";
    this.code = code;
  }
}

export class CodeChangeLoopService {
  private readonly state: LocalStateService;
  private readonly runner: CodeChangeRunnerExecutor;
  private readonly now: () => string;

  constructor(deps: CodeChangeLoopServiceDeps) {
    this.state = deps.state;
    this.runner = deps.runner;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async runAttempt(
    input: CodeChangeLoopRunInput,
  ): Promise<CodeChangeAttemptResult> {
    const taskRun = await this.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new CodeChangeLoopError(
        "CODE_CHANGE_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    const changeApprovals = await this.loadApprovedApprovals({
      taskRunId: taskRun.id,
      approvalIds: input.changeApprovalIds,
      expectedActionTypes: ["file_patch", "file_write"],
      purpose: "code change",
    });
    const verificationApprovalIds = input.verificationApprovalIds ?? [];
    const verificationApprovals = await this.loadApprovedApprovals({
      taskRunId: taskRun.id,
      approvalIds: verificationApprovalIds,
      expectedActionTypes: ["shell"],
      purpose: "verification",
    });

    const attemptNumber =
      input.attemptNumber ?? (await this.nextAttemptNumber(taskRun.id));
    const stepIndex = (await this.state.listStepsByTaskRun(taskRun.id)).length;
    const step = await this.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "quality_gate",
      title: `Code change loop attempt ${attemptNumber}`,
      status: "running",
      inputSummary: summarizeAttemptInput(changeApprovals, verificationApprovals),
    });
    await this.state.setTaskRunCurrentStep(taskRun.id, step.id);

    const base: CodeChangeAttemptResult = {
      attemptNumber,
      taskRunId: taskRun.id,
      status: "no_changes",
      nextAction: "ready_for_review",
      appliedApprovalIds: [],
      verificationApprovalIds: [...verificationApprovalIds],
      changedFiles: [],
      artifactIds: [],
      verificationResults: [],
    };

    if (changeApprovals.length === 0 && verificationApprovals.length === 0) {
      return this.finishAttempt({
        stepId: step.id,
        result: base,
        taskRunStatus: "ready_for_review",
        stepStatus: "succeeded",
      });
    }

    for (let i = 0; i < changeApprovals.length; i += 1) {
      const approval = changeApprovals[i]!;
      try {
        const executed = await this.runner.executeApproved(approval.id);
        base.appliedApprovalIds.push(approval.id);
        base.artifactIds.push(...executed.artifactIds);
        base.changedFiles.push(...(executed.changedFiles ?? []));
      } catch (e) {
        const nextAction = nextActionForApplyFailure(e);
        const failureMessage = errorMessage(e);
        await this.resolveFailedAttemptApprovals({
          failedApproval: approval,
          skippedApprovals: [
            ...changeApprovals.slice(i + 1),
            ...verificationApprovals,
          ],
          failureMessage,
        });
        return this.finishAttempt({
          stepId: step.id,
          result: {
            ...base,
            status: "apply_failed",
            nextAction,
            failureMessage,
          },
          taskRunStatus:
            nextAction === "repair_required" ? "quality_failed" : "blocked",
          stepStatus: "failed",
        });
      }
    }

    for (let i = 0; i < verificationApprovals.length; i += 1) {
      const approval = verificationApprovals[i]!;
      let executed: CodeChangeRunnerResult;
      try {
        executed = await this.runner.executeApproved(approval.id);
      } catch (e) {
        const failureMessage = errorMessage(e);
        await this.resolveFailedAttemptApprovals({
          failedApproval: approval,
          skippedApprovals: verificationApprovals.slice(i + 1),
          failureMessage,
        });
        return this.finishAttempt({
          stepId: step.id,
          result: {
            ...base,
            status: "verification_failed",
            nextAction: "repair_required",
            failureMessage,
          },
          taskRunStatus: "quality_failed",
          stepStatus: "failed",
        });
      }
      const verification = toVerificationResult(approval.id, executed);
      base.verificationResults.push(verification);
      base.artifactIds.push(...executed.artifactIds);
      if (verification.exitCode !== 0) {
        const failureMessage =
          verification.stderr ??
          verification.stdout ??
          `${verification.commandSummary} exited ${verification.exitCode}`;
        await this.resolveFailedAttemptApprovals({
          failedApproval: approval,
          skippedApprovals: verificationApprovals.slice(i + 1),
          failureMessage,
        });
        return this.finishAttempt({
          stepId: step.id,
          result: {
            ...base,
            status: "verification_failed",
            nextAction: "repair_required",
            failureMessage,
          },
          taskRunStatus: "quality_failed",
          stepStatus: "failed",
        });
      }
    }

    return this.finishAttempt({
      stepId: step.id,
      result: {
        ...base,
        status:
          verificationApprovals.length > 0 ? "verified" : "applied_unverified",
        nextAction: "ready_for_review",
      },
      taskRunStatus: "ready_for_review",
      stepStatus: "succeeded",
    });
  }

  private async loadApprovedApprovals(input: {
    taskRunId: string;
    approvalIds: readonly string[];
    expectedActionTypes: readonly Approval["actionType"][];
    purpose: string;
  }): Promise<Approval[]> {
    const approvals: Approval[] = [];
    for (const approvalId of input.approvalIds) {
      const approval = await this.state.getApproval(approvalId);
      if (!approval) {
        throw new CodeChangeLoopError(
          "CODE_CHANGE_APPROVAL_NOT_FOUND",
          `${input.purpose} approval ${approvalId} not found`,
        );
      }
      if (approval.taskRunId !== input.taskRunId) {
        throw new CodeChangeLoopError(
          "CODE_CHANGE_APPROVAL_TASK_MISMATCH",
          `${input.purpose} approval ${approvalId} belongs to ${approval.taskRunId}, not ${input.taskRunId}`,
        );
      }
      if (!input.expectedActionTypes.includes(approval.actionType)) {
        throw new CodeChangeLoopError(
          "CODE_CHANGE_APPROVAL_TYPE_MISMATCH",
          `${input.purpose} approval ${approvalId} must be ${input.expectedActionTypes.join(" or ")}, got ${approval.actionType}`,
        );
      }
      if (
        approval.status !== "approved" &&
        approval.status !== "always_approved_for_run"
      ) {
        throw new CodeChangeLoopError(
          "CODE_CHANGE_APPROVAL_NOT_APPROVED",
          `${input.purpose} approval ${approvalId} is ${approval.status}`,
        );
      }
      approvals.push(approval);
    }
    return approvals;
  }

  private async resolveFailedAttemptApprovals(input: {
    failedApproval: Approval;
    skippedApprovals: readonly Approval[];
    failureMessage: string;
  }): Promise<void> {
    const checkpointIds = new Set<string>();
    await this.rejectIfUnresolved(
      input.failedApproval,
      `Execution failed: ${input.failureMessage}`,
    );
    checkpointIds.add(input.failedApproval.checkpointId);
    for (const approval of input.skippedApprovals) {
      await this.rejectIfUnresolved(
        approval,
        `Skipped because ${input.failedApproval.actionType} approval ${input.failedApproval.id} failed`,
      );
      checkpointIds.add(approval.checkpointId);
    }
    await this.closeFailedApprovalSteps({
      taskRunId: input.failedApproval.taskRunId,
      checkpointIds,
      summary: input.failureMessage,
    });
  }

  private async rejectIfUnresolved(
    approval: Approval,
    message: string,
  ): Promise<void> {
    const latest = await this.state.getApproval(approval.id);
    if (!latest || !isUnresolvedApprovalStatus(latest.status)) return;
    await this.state.decideApproval(
      approval.id,
      "rejected",
      message.slice(0, 500),
    );
  }

  private async closeFailedApprovalSteps(input: {
    taskRunId: string;
    checkpointIds: ReadonlySet<string>;
    summary: string;
  }): Promise<void> {
    const [approvals, checkpoints] = await Promise.all([
      this.state.listApprovalsByTaskRun(input.taskRunId),
      this.state.listCheckpointsByTaskRun(input.taskRunId),
    ]);
    for (const checkpointId of input.checkpointIds) {
      const checkpointApprovals = approvals.filter(
        (approval) => approval.checkpointId === checkpointId,
      );
      if (
        checkpointApprovals.length === 0 ||
        checkpointApprovals.some((approval) =>
          isUnresolvedApprovalStatus(approval.status),
        )
      ) {
        continue;
      }
      const checkpoint = checkpoints.find(
        (candidate) => candidate.id === checkpointId,
      );
      if (!checkpoint) continue;
      await this.state.setStepStatus(checkpoint.stepId, "failed", {
        outputSummary: input.summary.slice(0, 200),
      });
    }
  }

  private async nextAttemptNumber(taskRunId: string): Promise<number> {
    const artifacts = await this.state.listArtifactsByTaskRun(taskRunId);
    let maxAttempt = 0;
    for (const artifact of artifacts) {
      if (artifact.kind !== "quality_report") continue;
      const match = /^Code change loop attempt (\d+)$/.exec(artifact.title);
      const rawAttempt = match?.[1];
      if (!rawAttempt) continue;
      const parsed = Number.parseInt(rawAttempt, 10);
      if (Number.isSafeInteger(parsed) && parsed > maxAttempt) {
        maxAttempt = parsed;
      }
    }
    return maxAttempt + 1;
  }

  private async finishAttempt(input: {
    stepId: string;
    result: CodeChangeAttemptResult;
    taskRunStatus: TaskRunStatus;
    stepStatus: "succeeded" | "failed";
  }): Promise<CodeChangeAttemptResult> {
    const manifest = await this.state.createArtifact({
      taskRunId: input.result.taskRunId,
      stepId: input.stepId,
      kind: "quality_report",
      title: `Code change loop attempt ${input.result.attemptNumber}`,
      uri: `harness:code-change-loop/${input.result.taskRunId}/${input.result.attemptNumber}/${this.now()}`,
      summary: formatAttemptManifest(input.result),
    });
    const result = {
      ...input.result,
      artifactIds: [...input.result.artifactIds, manifest.id],
    };
    await this.recordQualityGate(result);
    await this.state.setStepStatus(input.stepId, input.stepStatus, {
      outputSummary: `${result.status}; next=${result.nextAction}`,
    });
    await this.state.setTaskRunStatus(result.taskRunId, input.taskRunStatus);
    return result;
  }

  private async recordQualityGate(
    result: CodeChangeAttemptResult,
  ): Promise<void> {
    if (
      result.status !== "verified" &&
      result.status !== "verification_failed" &&
      result.status !== "applied_unverified" &&
      !(
        result.status === "apply_failed" &&
        result.nextAction === "repair_required"
      )
    ) {
      return;
    }

    const failedVerification = result.verificationResults.find(
      (verification) => verification.exitCode !== 0,
    );
    const knownRisks =
      result.status === "apply_failed"
        ? [
            [
              `attempt ${result.attemptNumber}`,
              result.failureMessage ?? "apply failed",
            ].join(": "),
          ]
        : result.status === "verification_failed"
        ? [
            [
              failedVerification?.commandSummary ??
                `attempt ${result.attemptNumber}`,
              result.failureMessage ?? "verification failed",
            ].join(": "),
          ]
        : result.status === "applied_unverified"
          ? ["No verification approvals were supplied for this code change attempt"]
          : [];

    await this.state.createQualityGateResult({
      id: newId("qualityGate"),
      taskRunId: result.taskRunId,
      status:
        result.status === "verified"
          ? "passed"
          : result.status === "applied_unverified"
            ? "warning"
            : "failed",
      testsPassed:
        result.status === "verified"
          ? true
          : result.status === "verification_failed"
            ? false
            : undefined,
      changedFilesReviewed: result.changedFiles.length > 0,
      knownRisks,
      evidenceArtifactIds: [...new Set(result.artifactIds)],
      createdAt: this.now(),
    });
  }
}

const summarizeAttemptInput = (
  changes: readonly Approval[],
  verifications: readonly Approval[],
): string =>
  [
    `changes=${changes.length}`,
    `verifications=${verifications.length}`,
  ].join(", ");

const toVerificationResult = (
  approvalId: string,
  result: CodeChangeRunnerResult,
): CodeChangeVerificationResult => ({
  approvalId,
  commandSummary: result.commandSummary,
  exitCode: result.exitCode ?? 0,
  ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
  ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
  artifactIds: [...result.artifactIds],
});

const formatAttemptManifest = (result: CodeChangeAttemptResult): string => {
  const lines = [
    `# Code change loop attempt ${result.attemptNumber}`,
    "",
    `status: ${result.status}`,
    `nextAction: ${result.nextAction}`,
    "",
    "## Applied approvals",
    ...formatList(result.appliedApprovalIds),
    "",
    "## Changed files",
    ...formatList(result.changedFiles),
    "",
    "## Verification",
    ...formatVerification(result.verificationResults),
  ];
  if (result.failureMessage) {
    lines.push("", "## Failure", result.failureMessage);
  }
  return lines.join("\n");
};

const formatList = (items: readonly string[]): string[] =>
  items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);

const formatVerification = (
  results: readonly CodeChangeVerificationResult[],
): string[] => {
  if (results.length === 0) return ["- none"];
  return results.map(
    (result) =>
      `- ${result.commandSummary}: exitCode ${result.exitCode ?? "unknown"}`,
  );
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isUnresolvedApprovalStatus = (status: Approval["status"]): boolean =>
  status === "pending" ||
  status === "approved" ||
  status === "always_approved_for_run";

const nextActionForApplyFailure = (error: unknown): CodeChangeNextAction =>
  errorCode(error) === "RUNNER_PATCH_CONTEXT_MISMATCH"
    ? "repair_required"
    : "blocked";

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
