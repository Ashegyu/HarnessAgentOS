import type { PolicyEvaluation } from "./policy.ts";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "always_approved_for_run"
  | "executed";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "always_approved_for_run",
  "executed",
];

export type ApprovalScope = "once" | "run_action_class";

export type ApprovalActionType =
  | "capability_use"
  | "model_use"
  | "file_write"
  | "shell"
  | "dependency_install"
  | "git_commit"
  | "network"
  | "skill_script"
  | "orchestration_plan";

export const APPROVAL_ACTION_TYPES: readonly ApprovalActionType[] = [
  "capability_use",
  "model_use",
  "file_write",
  "shell",
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
  "orchestration_plan",
];

export interface ProposedFilePatch {
  path: string;
  before?: string;
  after: string;
}

export interface ProposedCapabilityUse {
  capabilityId: string;
  capabilityName: string;
  reason: string;
  matchedTerms: string[];
}

export interface ProposedModelUse {
  model: string;
  reason: string;
  recommendationId: string;
  confidence: number;
}

/**
 * Concrete execution detail attached to an Approval. Phase 2 stores
 * this on the approval row (column added by Phase 3 migration). The
 * deterministic plan-drafter leaves command/filePatch undefined; the
 * UI lets the user fill in details before runner.executeApproved.
 */
export interface ProposedActionDetails {
  type: ApprovalActionType;
  command?: string;
  args?: string[];
  cwd?: string;
  filePatch?: ProposedFilePatch;
  capabilityUse?: ProposedCapabilityUse;
  modelUse?: ProposedModelUse;
}

export interface Approval {
  id: string;
  taskRunId: string;
  checkpointId: string;
  actionType: ApprovalActionType;
  actionSummary: string;
  status: ApprovalStatus;
  proposedAction?: ProposedActionDetails;
  policyEvaluation?: PolicyEvaluation;
  decisionMessage?: string;
  decidedAt?: string;
}

export interface CreateApprovalInput {
  taskRunId: string;
  checkpointId: string;
  actionType: ApprovalActionType;
  actionSummary: string;
  status?: ApprovalStatus;
  proposedAction?: ProposedActionDetails;
  policyEvaluation?: PolicyEvaluation;
}
