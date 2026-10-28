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
}
