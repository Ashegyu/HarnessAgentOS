import type {
  Approval,
  Artifact,
  AutoApproveDecision,
} from "@harness/core";

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
  approval: Pick<Approval, "policyEvaluation">,
): AutoApproveDecision => {
  if (approval.policyEvaluation?.decision === "blocked") {
    return {
      approved: false,
      decidedAt: "policy_blocked",
      reason: `Policy blocked pipeline auto-approve: ${approval.policyEvaluation.reason}`,
    };
  }
  return {
    approved: true,
    decidedAt: "global_toggle",
    reason:
      "Orchestration task was pre-approved by explicit pipeline or harness selection; active profile block lists do not apply to worker approvals.",
  };
};
