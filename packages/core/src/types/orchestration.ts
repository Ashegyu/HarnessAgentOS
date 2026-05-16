import type { ApprovalActionType } from "./approval.ts";

export type OrchestrationMode =
  | "single_worker"
  | "planner_worker"
  | "multi_worker";

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  "single_worker",
  "planner_worker",
  "multi_worker",
];

export type WorkerRole =
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "orchestrator"
  | "security-reviewer"
  | "build-error-resolver"
  | "refactor-cleaner"
  | "performance-reviewer";

export const WORKER_ROLES: readonly WorkerRole[] = [
  "planner",
  "coder",
  "reviewer",
  "tester",
  "orchestrator",
  "security-reviewer",
  "build-error-resolver",
  "refactor-cleaner",
  "performance-reviewer",
];

export type WorkerOutputContract =
  | "plan"
  | "diff_proposal"
  | "review"
  | "test_result";

export const WORKER_OUTPUT_CONTRACTS: readonly WorkerOutputContract[] = [
  "plan",
  "diff_proposal",
  "review",
  "test_result",
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
  /**
   * Optional A2A endpoint override for pipeline-driven steps. The
   * AgentProfile remains the approved persona/permission source; this
   * selects a trusted remote worker transport.
   */
  remoteEndpointId?: string;
  /**
   * WorkerStep ids that must complete before this step runs. Missing
   * means legacy linear handoff behavior; an empty array means the step
   * is explicitly independent.
   */
  dependsOn?: readonly string[];
  /**
   * Side-effect proposal classes this worker may surface as downstream
   * approvals. The worker still cannot execute them directly.
   */
  allowedActions?: readonly ApprovalActionType[];
  /**
   * Advisory output shape expected from the worker. This is used for UI
   * and audit traces; quality gates still validate concrete artifacts.
   */
  outputContract?: WorkerOutputContract;
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
