import type {
  Approval,
  Artifact,
  AutoApproveDecision,
} from "@harness/core";

const SOURCE_PIPELINE_RE = /"sourcePipelineId"\s*:\s*"[^"]+"/;

export const hasPipelineSourcePlanArtifact = (
  artifacts: readonly Pick<Artifact, "kind" | "summary">[],
): boolean =>
  artifacts.some(
    (artifact) =>
      artifact.kind === "orchestration_plan" &&
      SOURCE_PIPELINE_RE.test(artifact.summary ?? ""),
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
      "Pipeline task was pre-approved by explicit pipeline selection; active profile block lists do not apply to pipeline worker approvals.",
  };
};
