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
  /**
   * Display-only summary, truncated for the plan UI / artifact headers.
   * The full user-request text used by the CLI lives in `instruction`.
   */
  inputSummary: string;
  /**
   * Full text passed to the agent CLI as the worker's userRequest at
   * runtime. For pipeline-driven plans this is `AgentPipelineStep
   * .instruction` verbatim (no truncation). For legacy mode-driven
   * plans this is the TaskRun.userRequest, also untruncated.
   *
   * Optional for backward compatibility with plans drafted before v12 —
   * worker-runner falls back to `inputSummary` when `instruction` is
   * missing.
   */
  instruction?: string;
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
