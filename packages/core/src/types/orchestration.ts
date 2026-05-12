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
  /**
   * When set, the worker-runner invokes this specific AgentProfile
   * instead of resolving the active/default by role. Synthesized from
   * pipeline steps; legacy `mode`-driven plans omit it.
   */
  agentProfileId?: string;
}

export interface OrchestrationPlan {
  id: string;
  taskRunId: string;
  mode: OrchestrationMode;
  workerSteps: WorkerStep[];
  requiresApproval: true;
  /**
   * If the plan was synthesized from an AgentPipeline template, the
   * pipeline's id is preserved here for audit/replay. The plan itself
   * is still the immutable snapshot — later edits to the pipeline do
   * NOT affect already-synthesized plans.
   */
  sourcePipelineId?: string;
}

export interface OrchestrationRunResult {
  planId: string;
  taskRunId: string;
  workerStepArtifactIds: string[];
  workerSteps: WorkerStep[];
  proposedApprovalIds: string[];
}
