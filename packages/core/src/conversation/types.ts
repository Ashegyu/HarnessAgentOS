import type {
  Approval,
  ApprovalActionType,
  ApprovalScope,
  AutoApproveDecision,
  Artifact,
  Checkpoint,
  TaskRun,
} from "../types";

/**
 * Phase 8 — TaskRun creation modes.
 *
 * `template` (default): deterministic plan-drafter creates a plan
 *   artifact + before_edit checkpoint + placeholder approval. TaskRun
 *   immediately moves to `waiting_for_approval`.
 * `agent`: Thread/TaskRun + before_edit checkpoint only. plan artifact
 *   and approvals are NOT created — the caller must follow up with
 *   `agent.generatePlan(taskRunId)`. TaskRun stays in `drafting` until
 *   that succeeds (→ `waiting_for_approval` or `ready_for_review`) or
 *   fails (→ `blocked`).
 *
 * Mode is **locked at TaskRun creation time** — switching mid-flight is
 * not supported; create a new TaskRun (or use `redirectTask`) instead.
 */
export type ConversationTaskMode = "template" | "agent";

export interface CreateConversationTaskInput {
  threadId?: string;
  userRequest: string;
  targetDir?: string;
  /**
   * Previous TaskRun in the same thread that this request continues.
   * Used as an explicit follow-up anchor for agent prompts.
   */
  followUpTaskRunId?: string;
  mode?: ConversationTaskMode;
}

export interface ConversationTaskDraft {
  taskRun: TaskRun;
  /**
   * Always present in `template` mode. In `agent` mode this is a
   * placeholder draft artifact (kind="plan", summary="awaiting agent")
   * so existing renderer code keeps working; `agent.generatePlan`
   * replaces or supersedes it.
   */
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  /** 0 approvals in `agent` mode until `agent.generatePlan` runs. */
  approvals: Approval[];
}

export interface ProposedAction {
  type: ApprovalActionType;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: true;
}

export interface ApproveInput {
  approvalId: string;
  message?: string;
  scope?: ApprovalScope;
  autoApproveDecision?: AutoApproveDecision | null;
}

export interface RejectApprovalInput {
  approvalId: string;
  message: string;
}

export interface RedirectTaskInput {
  taskRunId: string;
  instruction: string;
}

export interface PauseTaskInput {
  taskRunId: string;
}

export interface ResumeTaskInput {
  taskRunId: string;
}

export interface CancelTaskInput {
  taskRunId: string;
  reason: string;
}

export interface UseTemplateFallbackInput {
  taskRunId: string;
}

export interface TemplateFallbackResult {
  planArtifact: Artifact;
  approvals: Approval[];
}
