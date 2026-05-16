export type RepairAttemptStatus =
  | "planned"
  | "waiting_for_approval"
  | "executed"
  | "passed"
  | "failed"
  | "stopped";

export interface RepairAttempt {
  id: string;
  taskRunId: string;
  qualityGateId: string;
  attemptIndex: number;
  failureSignature: string;
  status: RepairAttemptStatus;
  invocationId?: string;
  generatedApprovalIds: string[];
  createdAt: string;
  updatedAt: string;
}
