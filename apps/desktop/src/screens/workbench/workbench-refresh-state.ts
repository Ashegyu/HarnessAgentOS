import type { TaskRunDetail, Thread, ThreadDetail } from "@harness/core";

export type ThreadsState =
  | { kind: "loading" }
  | { kind: "ready"; threads: Thread[] }
  | { kind: "error"; message: string };

export type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; threadId: string }
  | { kind: "ready"; detail: ThreadDetail }
  | { kind: "error"; threadId: string; message: string };

export type TaskRunDetailState =
  | { kind: "idle" }
  | { kind: "loading"; taskRunId: string }
  | { kind: "ready"; detail: TaskRunDetail }
  | { kind: "error"; taskRunId: string; message: string };

export const beginThreadDetailRefresh = (
  previous: DetailState,
  threadId: string,
): DetailState => {
  if (previous.kind === "ready" && previous.detail.thread.id === threadId) {
    return previous;
  }
  return { kind: "loading", threadId };
};

export const beginTaskRunDetailRefresh = (
  previous: TaskRunDetailState,
  taskRunId: string,
): TaskRunDetailState => {
  if (
    previous.kind === "ready" &&
    previous.detail.taskRun.id === taskRunId
  ) {
    return previous;
  }
  return { kind: "loading", taskRunId };
};
