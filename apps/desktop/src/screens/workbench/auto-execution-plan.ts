import { validateProposedActionDetails } from "@harness/core";
import type {
  Approval,
  CodeChangeAttemptResult,
  CodeChangeNextAction,
} from "@harness/core";

export interface CodeChangeAttemptExecution {
  taskRunId: string;
  changeApprovalIds: string[];
  verificationApprovalIds: string[];
}

export interface AutoApprovedExecutionPlan {
  orchestrationApprovalIds: string[];
  continuationOrchestrationApprovalIds?: string[];
  advisoryApprovalIds: string[];
  individualRunnerApprovalIds: string[];
  skippedRunnerApprovalIds: string[];
  codeChangeAttempt: CodeChangeAttemptExecution | null;
}

export interface AutoExecutionApi {
  runOrchestrationApproved(input: { approvalId: string }): Promise<unknown>;
  executeCodeChangeAttempt(
    input: CodeChangeAttemptExecution,
  ): Promise<Pick<CodeChangeAttemptResult, "taskRunId" | "nextAction">>;
  createRepairPlan(input: {
    taskRunId: string;
    instruction?: string;
  }): Promise<unknown>;
  executeApproved(input: { approvalId: string }): Promise<unknown>;
}

export interface AutoExecutionRunResult {
  failedApprovalIds: string[];
  repairPlanTaskRunIds: string[];
}

export const CODE_CHANGE_REPAIR_INSTRUCTION =
  "Repair the failed code-change verification and propose the next approval-gated file_patch/file_write and shell check set.";

const isAdvisoryApproval = (approval: Approval): boolean =>
  approval.actionType === "capability_use" || approval.actionType === "model_use";

const isOrchestrationApproval = (approval: Approval): boolean =>
  approval.actionType === "orchestration_plan";

export const isRunnerExecutionApproval = (approval: Approval): boolean =>
  !isOrchestrationApproval(approval) && !isAdvisoryApproval(approval);

export const autoExecutableRunnerApprovalIssue = (
  approval: Approval,
): string | null => {
  if (!isCodeChangeLoopAction(approval)) {
    return `Unsupported runner action type: ${approval.actionType}`;
  }
  if (!approval.proposedAction) {
    return "Missing proposedAction";
  }
  const validation = validateProposedActionDetails(
    approval.proposedAction,
    approval.actionType,
  );
  if (!validation.ok) {
    return validation.reason ?? "Invalid proposedAction";
  }
  return null;
};

export const isAutoExecutableRunnerApproval = (approval: Approval): boolean =>
  autoExecutableRunnerApprovalIssue(approval) === null;

export const isApprovedForPipelineAutoExecution = (
  approval: Approval,
): boolean => {
  if (
    approval.status !== "approved" &&
    approval.status !== "always_approved_for_run"
  ) {
    return false;
  }
  if (isAdvisoryApproval(approval)) return false;
  if (isOrchestrationApproval(approval)) return true;
  return isAutoExecutableRunnerApproval(approval);
};

const isCodeChangeLoopAction = (approval: Approval): boolean =>
  isChangeApproval(approval) || approval.actionType === "shell";

const isChangeApproval = (approval: Approval): boolean =>
  approval.actionType === "file_patch" || approval.actionType === "file_write";

/**
 * Build the execution plan for approvals that have already passed the
 * auto-approval policy. Only a straightforward file_patch/file_write* then shell*
 * sequence is batched into the code-change loop; ambiguous ordering falls
 * back to the legacy per-approval runner path to preserve behavior.
 */
export const buildAutoApprovedExecutionPlan = (
  taskRunId: string,
  approvals: readonly Approval[],
): AutoApprovedExecutionPlan => {
  const orchestrationApprovalIds: string[] = [];
  const advisoryApprovalIds: string[] = [];
  const runnerApprovals: Approval[] = [];
  const skippedRunnerApprovalIds: string[] = [];

  for (const approval of approvals) {
    if (isOrchestrationApproval(approval)) {
      orchestrationApprovalIds.push(approval.id);
    } else if (isAdvisoryApproval(approval)) {
      advisoryApprovalIds.push(approval.id);
    } else if (isAutoExecutableRunnerApproval(approval)) {
      runnerApprovals.push(approval);
    } else {
      skippedRunnerApprovalIds.push(approval.id);
    }
  }

  const canBatchCodeChange =
    runnerApprovals.some(isChangeApproval) &&
    runnerApprovals.every(isCodeChangeLoopAction) &&
    isChangeThenShellSequence(runnerApprovals);

  if (!canBatchCodeChange) {
    return {
      orchestrationApprovalIds,
      advisoryApprovalIds,
      individualRunnerApprovalIds: runnerApprovals.map((approval) => approval.id),
      skippedRunnerApprovalIds,
      codeChangeAttempt: null,
    };
  }

  return {
    orchestrationApprovalIds,
    advisoryApprovalIds,
    individualRunnerApprovalIds: [],
    skippedRunnerApprovalIds,
    codeChangeAttempt: {
      taskRunId,
      changeApprovalIds: runnerApprovals
        .filter(isChangeApproval)
        .map((approval) => approval.id),
      verificationApprovalIds: runnerApprovals
        .filter((approval) => approval.actionType === "shell")
        .map((approval) => approval.id),
    },
  };
};

export const shouldAutoCreateRepairPlanAfterAttempt = (input: {
  isPipelineAutoTask: boolean;
  nextAction: CodeChangeNextAction;
}): boolean =>
  input.isPipelineAutoTask && input.nextAction === "repair_required";

export const runAutoApprovedExecutionPlan = async (input: {
  api: AutoExecutionApi;
  executionPlan: AutoApprovedExecutionPlan;
  isPipelineAutoTask: boolean;
  onError?: (context: string, error: unknown) => void;
}): Promise<AutoExecutionRunResult> => {
  const failedApprovalIds: string[] = [];
  const repairPlanTaskRunIds: string[] = [];

  for (const approvalId of input.executionPlan.orchestrationApprovalIds) {
    try {
      await input.api.runOrchestrationApproved({ approvalId });
    } catch (error) {
      failedApprovalIds.push(approvalId);
      input.onError?.(`orchestration:${approvalId}`, error);
    }
  }

  if (input.executionPlan.codeChangeAttempt) {
    const attemptApprovalIds = [
      ...input.executionPlan.codeChangeAttempt.changeApprovalIds,
      ...input.executionPlan.codeChangeAttempt.verificationApprovalIds,
    ];
    try {
      const result = await input.api.executeCodeChangeAttempt(
        input.executionPlan.codeChangeAttempt,
      );
      if (
        shouldAutoCreateRepairPlanAfterAttempt({
          isPipelineAutoTask: input.isPipelineAutoTask,
          nextAction: result.nextAction,
        })
      ) {
        try {
          await input.api.createRepairPlan({
            taskRunId: result.taskRunId,
            instruction: CODE_CHANGE_REPAIR_INSTRUCTION,
          });
          repairPlanTaskRunIds.push(result.taskRunId);
        } catch (error) {
          input.onError?.(`repair:${result.taskRunId}`, error);
        }
      }
    } catch (error) {
      failedApprovalIds.push(...attemptApprovalIds);
      input.onError?.("code-change-attempt", error);
    }
  }

  for (const approvalId of input.executionPlan.individualRunnerApprovalIds) {
    try {
      await input.api.executeApproved({ approvalId });
    } catch (error) {
      failedApprovalIds.push(approvalId);
      input.onError?.(`runner:${approvalId}`, error);
    }
  }

  if (failedApprovalIds.length === 0) {
    for (const approvalId of input.executionPlan.continuationOrchestrationApprovalIds ??
      []) {
      try {
        await input.api.runOrchestrationApproved({ approvalId });
      } catch (error) {
        failedApprovalIds.push(approvalId);
        input.onError?.(`orchestration-continuation:${approvalId}`, error);
      }
    }
  }

  return { failedApprovalIds, repairPlanTaskRunIds };
};

const isChangeThenShellSequence = (
  approvals: readonly Approval[],
): boolean => {
  let sawShell = false;
  for (const approval of approvals) {
    if (approval.actionType === "shell") {
      sawShell = true;
      continue;
    }
    if (isChangeApproval(approval) && sawShell) return false;
  }
  return true;
};
