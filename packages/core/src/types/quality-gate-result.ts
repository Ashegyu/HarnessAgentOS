export type QualityGateStatus = "passed" | "failed" | "warning" | "not_run";

export const QUALITY_GATE_STATUSES: readonly QualityGateStatus[] = [
  "passed",
  "failed",
  "warning",
  "not_run",
];

export interface QualityGateResult {
  id: string;
  taskRunId: string;
  status: QualityGateStatus;
  buildPassed?: boolean;
  testsPassed?: boolean;
  smokePassed?: boolean;
  changedFilesReviewed?: boolean;
  knownRisks: string[];
  evidenceArtifactIds: string[];
  createdAt: string;
}

export interface QualityGateInput {
  taskRunId: string;
  requireBuild?: boolean;
  requireTests?: boolean;
  requireSmoke?: boolean;
}
