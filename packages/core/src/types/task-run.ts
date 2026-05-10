export type TaskRunStatus =
  | "drafting"
  | "waiting_for_approval"
  | "running"
  | "paused"
  | "blocked"
  | "quality_failed"
  | "ready_for_review"
  | "done"
  | "cancelled";

export const TASK_RUN_STATUSES: readonly TaskRunStatus[] = [
  "drafting",
  "waiting_for_approval",
  "running",
  "paused",
  "blocked",
  "quality_failed",
  "ready_for_review",
  "done",
  "cancelled",
];

export interface TaskRun {
  id: string;
  threadId: string;
  userRequest: string;
  targetDir: string;
  status: TaskRunStatus;
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRunInput {
  threadId: string;
  userRequest: string;
  targetDir: string;
  status?: TaskRunStatus;
}
