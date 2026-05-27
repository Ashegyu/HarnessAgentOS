// Domain types live in @harness/core so the IPC surface can reference
// them without a reverse dependency. This file just re-exports them
// alongside orchestration-specific helpers.
export {
  ORCHESTRATION_MODES,
  WORKER_ROLES,
} from "@harness/core";
export type {
  OrchestrationMode,
  OrchestrationPlan,
  OrchestrationRunResult,
  PipelineBackflowAttempt,
  PipelineBackflowEventType,
  PipelineBackflowTrigger,
  WorkerBackflowRule,
  WorkerRole,
  WorkerStep,
  WorkerStepStatus,
} from "@harness/core";

export interface OrchestrationDraftInput {
  taskRunId: string;
  mode: import("@harness/core").OrchestrationMode;
  instruction?: string;
  /**
   * When set, the planner expands this AgentPipeline's steps into
   * `workerSteps` instead of using the hardcoded `mode` synthesizer.
   * The `mode` field is preserved in the plan for audit but does not
   * affect step generation when `pipelineId` is supplied.
   */
  pipelineId?: string;
  /**
   * Direct harness source. When supplied, the planner reads the saved
   * HarnessDefinition snapshot and HarnessBindingSet, converts the workflow
   * to worker steps in memory, and does not persist an AgentPipeline row.
   */
  harness?: {
    packageId: string;
    workflowId?: string;
    bindingSetId: string;
  };
}

export interface OrchestrationApprovalInput {
  planId: string;
}

export interface OrchestrationRunInput {
  approvalId: string;
}

export class OrchestrationError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
  }
}
