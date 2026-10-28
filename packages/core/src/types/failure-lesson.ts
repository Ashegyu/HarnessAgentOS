/** An observed repair, not a proof that the proposed explanation is causal. */
export interface FailureLesson {
  version: 1;
  failureRunId: string;
  recoveryRunId: string;
  checkerId: string;
  symptom: string;
  repairHypothesis: string;
  causeStatus: "hypothesis";
  patchExcerpt: string;
  applicabilityTerms: string[];
  evidenceArtifactIds: string[];
  sourceContract?: string;
  /** A phase observation plus a changed checker/source, never inferred from log wording. */
  control?: {
    kind: "verification_repair" | "implementation_repair";
    contractId: string;
    failedReferenceExitCode: number;
    failedCandidateExitCode?: number;
    recoveredReferenceExitCode: 0;
    recoveredCandidateExitCode: 0;
  };
}
