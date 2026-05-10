export type OrchestrationMode =
  | "single_worker"
  | "planner_worker"
  | "multi_worker";

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  "single_worker",
  "planner_worker",
  "multi_worker",
];

export type WorkerRole = "planner" | "coder" | "reviewer" | "tester";

export const WORKER_ROLES: readonly WorkerRole[] = [
  "planner",
  "coder",
  "reviewer",
  "tester",
];

export type WorkerStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkerStep {
  id: string;
  title: string;
  role: WorkerRole;
  inputSummary: string;
  expectedArtifactKinds: string[];
  status: WorkerStepStatus;
}

export interface OrchestrationPlan {
  id: string;
  taskRunId: string;
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
  requiresApproval: true;
}

export interface OrchestrationRunResult {
  planId: string;
  taskRunId: string;
  workerStepArtifactIds: string[];
  workerSteps: WorkerStep[];
  proposedApprovalIds: string[];
}
