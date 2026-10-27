export type ValidationKind = "build" | "test" | "smoke";
export type ValidationRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Input identity plus host execution provenance; display labels are not evidence. */
export interface ValidationRun {
  id: string;
  sequence: number;
  taskRunId: string;
  stepId: string;
  approvalId: string;
  workspaceKey: string;
  checkerId: string;
  kinds: ValidationKind[];
  startFingerprint: string | null;
  startGeneration: number;
  finishFingerprint?: string | null;
  finishGeneration?: number;
  status: ValidationRunStatus;
  exitCode?: number;
  artifactId?: string;
  reason?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface BeginValidationRunInput {
  taskRunId: string;
  stepId: string;
  approvalId: string;
  workspaceKey: string;
  checkerId: string;
  kinds: ValidationKind[];
  startFingerprint: string | null;
  startGeneration: number;
  reason?: string;
}

export interface FinishValidationRunInput {
  status: Exclude<ValidationRunStatus, "running">;
  finishFingerprint: string | null;
  finishGeneration: number;
  exitCode?: number;
  artifactId?: string;
  reason?: string;
}

export interface QualityValidationState {
  workspaceKey: string;
  fingerprint: string | null;
  generation: number;
  watermark: number;
}
