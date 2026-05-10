import type { Thread } from "./thread";
import type { TaskRun } from "./task-run";

export interface ThreadDetail {
  thread: Thread;
  taskRuns: TaskRun[];
}
