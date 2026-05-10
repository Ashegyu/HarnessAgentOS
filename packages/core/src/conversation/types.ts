import type {
  Approval,
  ApprovalActionType,
  ApprovalScope,
  Artifact,
  Checkpoint,
  TaskRun,
} from "../types";

export interface CreateConversationTaskInput {
  threadId?: string;
  userRequest: string;
  targetDir?: string;
}

export interface ConversationTaskDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
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
