export type CheckpointReason =
  | "before_edit"
  | "before_shell"
  | "after_failure"
  | "before_commit"
  | "manual";

export interface Checkpoint {
  id: string;
  taskRunId: string;
  stepId: string;
  reason: CheckpointReason;
  stateRef: string;
  summary: string;
  createdAt: string;
}

export interface CreateCheckpointInput {
  taskRunId: string;
  stepId: string;
  reason: CheckpointReason;
  stateRef: string;
  summary: string;
}
