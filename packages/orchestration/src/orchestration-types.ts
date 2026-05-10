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
  WorkerRole,
  WorkerStep,
  WorkerStepStatus,
} from "@harness/core";

export interface OrchestrationDraftInput {
  taskRunId: string;
  mode: import("@harness/core").OrchestrationMode;
  instruction?: string;
}

export interface OrchestrationApprovalInput {
  planId: string;
}

export interface OrchestrationRunInput {
  approvalId: string;
}

export class OrchestrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}
