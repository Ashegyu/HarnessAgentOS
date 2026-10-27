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

/** One owner per selection lifetime; push bursts request one trailing fresh pull. */
export const createDetailRefreshController = <T>(callbacks: {
  load: (id: string) => Promise<T>;
  keyOf: (detail: T) => string;
  begin: (id: string | null) => void;
  ready: (detail: T) => void;
  error: (id: string, error: unknown) => void;
}) => {
  let selected: string | null = null;
  let generation = 0;
  let active: { dirty: boolean; promise: Promise<void> } | null = null;
  return {
    select(id: string | null): void {
      if (id === selected) return;
      selected = id;
      generation++;
      active = null;
      callbacks.begin(id);
    },
    refresh(id: string): Promise<void> {
      if (selected !== id) return Promise.resolve();
      if (active) {
        active.dirty = true;
        return active.promise;
      }
      const owner = generation;
      const current = (): boolean => selected === id && generation === owner;
      callbacks.begin(id);
      const work = { dirty: false, promise: Promise.resolve() };
      active = work;
      work.promise = Promise.resolve().then(async () => {
        try {
          do {
            work.dirty = false;
            try {
              const detail = await callbacks.load(id);
              if (current() && !work.dirty) {
                if (callbacks.keyOf(detail) !== id) throw new Error("상세 응답의 ID가 현재 요청과 다릅니다.");
                callbacks.ready(detail);
              }
            } catch (error) {
              if (current() && !work.dirty) callbacks.error(id, error);
            }
          } while (current() && work.dirty);
        } finally {
          // Release before promise settlement: a push in the intervening
          // microtask must start a new pull rather than dirty a finished loop.
          if (active === work) active = null;
        }
      });
      return work.promise;
    },
  };
};
