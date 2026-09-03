import type { TaskRunStatus } from "../types/task-run.ts";

const ALLOWED_TRANSITIONS: Readonly<
  Record<TaskRunStatus, ReadonlySet<TaskRunStatus>>
> = {
  drafting: new Set([
    "drafting",
    "waiting_for_approval",
    "running",
    "blocked",
    "quality_failed",
    "ready_for_review",
    "cancelled",
  ]),
  waiting_for_approval: new Set([
    "waiting_for_approval",
    "running",
    "paused",
    "blocked",
    "quality_failed",
    "ready_for_review",
    "cancelled",
  ]),
  running: new Set([
    "running",
    "waiting_for_approval",
    "paused",
    "blocked",
    "quality_failed",
    "ready_for_review",
    "cancelled",
  ]),
  paused: new Set([
    "paused",
    "waiting_for_approval",
    "running",
    "blocked",
    "quality_failed",
    "ready_for_review",
    "cancelled",
  ]),
  blocked: new Set([
    "blocked",
    "waiting_for_approval",
    "running",
    "quality_failed",
    "ready_for_review",
    "cancelled",
  ]),
  quality_failed: new Set([
    "quality_failed",
    "waiting_for_approval",
    "running",
    "blocked",
    "ready_for_review",
    "cancelled",
  ]),
  ready_for_review: new Set([
    "ready_for_review",
    "waiting_for_approval",
    "running",
    "quality_failed",
    "done",
    "cancelled",
  ]),
  // 완료된 A2A 결과에 refinement approval을 추가하는 기존 흐름만
  // 명시적으로 reopen한다. 실제 실행은 반드시 waiting -> running을 거친다.
  done: new Set(["done", "waiting_for_approval"]),
  cancelled: new Set(["cancelled"]),
};

export class TaskRunTransitionError extends Error {
  readonly code = "TASK_RUN_INVALID_TRANSITION";
  readonly from: TaskRunStatus;
  readonly to: TaskRunStatus;

  constructor(from: TaskRunStatus, to: TaskRunStatus) {
    super(`Invalid TaskRun transition ${from} -> ${to}`);
    this.name = "TaskRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export const isTaskRunTransitionAllowed = (
  from: TaskRunStatus,
  to: TaskRunStatus,
): boolean => ALLOWED_TRANSITIONS[from].has(to);

export const assertTaskRunTransition = (
  from: TaskRunStatus,
  to: TaskRunStatus,
): void => {
  if (!isTaskRunTransitionAllowed(from, to)) {
    throw new TaskRunTransitionError(from, to);
  }
};
