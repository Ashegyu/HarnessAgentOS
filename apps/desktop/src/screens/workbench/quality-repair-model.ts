import type {
  Approval,
  Artifact,
  QualityGateResult,
  RepairAttempt,
} from "@harness/core";

export interface RepairAttemptRow {
  attempt: RepairAttempt;
  attemptNumber: number;
  gateStatus: QualityGateResult["status"] | "missing";
  generatedApprovals: Approval[];
  diffArtifacts: Artifact[];
}

export const buildRepairAttemptRows = (input: {
  attempts: RepairAttempt[];
  qualityGates: QualityGateResult[];
  approvals: Approval[];
  artifacts: Artifact[];
}): RepairAttemptRow[] => {
  const gatesById = new Map(input.qualityGates.map((gate) => [gate.id, gate]));
  const approvalsById = new Map(
    input.approvals.map((approval) => [approval.id, approval]),
  );
  return [...input.attempts]
    .sort((a, b) => a.attemptIndex - b.attemptIndex || a.id.localeCompare(b.id))
    .map((attempt) => {
      const generatedApprovals = attempt.generatedApprovalIds
        .map((id) => approvalsById.get(id))
        .filter((approval): approval is Approval => approval !== undefined);
      return {
        attempt,
        attemptNumber: attempt.attemptIndex + 1,
        gateStatus: gatesById.get(attempt.qualityGateId)?.status ?? "missing",
        generatedApprovals,
        diffArtifacts: matchingDiffArtifacts(generatedApprovals, input.artifacts),
      };
    });
};

const matchingDiffArtifacts = (
  approvals: Approval[],
  artifacts: Artifact[],
): Artifact[] => {
  const filePaths = approvals
    .map((approval) => approval.proposedAction?.filePatch?.path)
    .filter((path): path is string => Boolean(path));
  if (filePaths.length === 0) return [];
  return artifacts.filter((artifact) => {
    if (artifact.kind !== "diff") return false;
    const haystack = `${artifact.title} ${artifact.summary ?? ""}`;
    return filePaths.some((path) => haystack.includes(path));
  });
};
