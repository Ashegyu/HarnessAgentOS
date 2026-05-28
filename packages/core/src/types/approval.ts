import type { PolicyEvaluation } from "./policy.ts";
import type { TaskRunStatus } from "./task-run.ts";

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
  | "file_patch"
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
  "file_patch",
  "file_write",
  "shell",
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
  "orchestration_plan",
];

export const AUTO_APPROVE_STEPS = [
  "blocked_action",
  "policy_blocked",
  "budget_blocked",
  "profile_auto_approve",
  "policy_disallow_auto",
  "worker_file_action",
  "global_toggle",
] as const;

export type AutoApproveStep = (typeof AUTO_APPROVE_STEPS)[number];

export interface AutoApproveDecision {
  approved: boolean;
  decidedAt: AutoApproveStep;
  reason: string;
}

export interface ApprovalDecisionOptions {
  autoApproveDecision?: AutoApproveDecision | null;
}

export interface ProposedFilePatch {
  path: string;
  before?: string;
  after: string;
}

export interface ProposedUnifiedPatch {
  path: string;
  patch: string;
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
  estimatedCostUsd?: number;
}

export interface ProposedDbSnapshotExport {
  targetPath: string;
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
  unifiedPatch?: ProposedUnifiedPatch;
  capabilityUse?: ProposedCapabilityUse;
  modelUse?: ProposedModelUse;
  dbSnapshotExport?: ProposedDbSnapshotExport;
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
  autoApproveDecision?: AutoApproveDecision | null;
  decisionMessage?: string;
  decidedAt?: string;
}

export interface DecisionLogFilter {
  decidedAtSteps?: AutoApproveStep[];
  actionTypes?: ApprovalActionType[];
  sinceIso?: string;
  untilIso?: string;
}

export interface DecisionLogInput {
  limit: number;
  offset: number;
  filter?: DecisionLogFilter;
}

export interface DecisionLogItem {
  approval: Approval & {
    autoApproveDecision: AutoApproveDecision;
    decidedAt: string;
  };
  threadId: string;
  threadTitle: string;
  taskRunId: string;
  taskRunUserRequest: string;
  taskRunStatus: TaskRunStatus;
}

export interface DecisionLogPage {
  items: DecisionLogItem[];
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
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
