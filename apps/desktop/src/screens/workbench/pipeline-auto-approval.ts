import type {
  AgentPermissions,
  Approval,
  Artifact,
  AutoApproveDecision,
} from "@harness/core";
import { evaluateBudget } from "@harness/core";

const SOURCE_ORCHESTRATION_PICK_RE =
  /"sourcePipelineId"\s*:\s*"[^"]+"|"sourceHarness"\s*:/;

export const hasPipelineSourcePlanArtifact = (
  artifacts: readonly Pick<Artifact, "kind" | "summary">[],
): boolean =>
  artifacts.some(
    (artifact) =>
      artifact.kind === "orchestration_plan" &&
      SOURCE_ORCHESTRATION_PICK_RE.test(artifact.summary ?? ""),
  );

export const pipelineAutoApproveDecision = (
  approval: Pick<Approval, "actionType" | "policyEvaluation">,
  options: {
    activeProfile?: {
      permissions: Pick<AgentPermissions, "blockedActions" | "budget">;
    } | null;
    accumulatedTaskRunCostUsd?: number;
    accumulatedDailyCostUsd?: number;
  } = {},
): AutoApproveDecision => {
  if (
    options.activeProfile?.permissions.blockedActions.includes(
      approval.actionType,
    )
  ) {
    return {
      approved: false,
      decidedAt: "blocked_action",
      reason: `Active profile blocks ${approval.actionType}.`,
    };
  }
  if (approval.policyEvaluation?.decision === "blocked") {
    return {
      approved: false,
      decidedAt: "policy_blocked",
      reason: `Policy blocked pipeline auto-approve: ${approval.policyEvaluation.reason}`,
    };
  }
  const budgetDecision = evaluateBudget({
    approval,
    profile: options.activeProfile ?? null,
    accumulatedTaskRunCostUsd: options.accumulatedTaskRunCostUsd,
    accumulatedDailyCostUsd: options.accumulatedDailyCostUsd,
  });
  if (budgetDecision.kind === "blocked") {
    return {
      approved: false,
      decidedAt: "budget_blocked",
      reason: budgetDecision.reason ?? "Profile budget blocks auto-approve.",
    };
  }
  return {
    approved: true,
    decidedAt: "global_toggle",
    reason: "Orchestration task was pre-approved by explicit pipeline or harness selection.",
  };
};
