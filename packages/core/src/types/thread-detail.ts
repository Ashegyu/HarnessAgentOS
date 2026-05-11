import type { Thread } from "./thread.ts";
import type { TaskRun } from "./task-run.ts";

export interface ThreadDetail {
  thread: Thread;
  taskRuns: TaskRun[];
  /**
   * taskRunId → latest plan artifact summary, when present. Lets the
   * conversation workbench render an agent reply bubble next to each
   * user request without doing N additional IPC round-trips. Absent
   * entries mean the TaskRun has not produced (or has not yet produced)
   * a plan artifact.
   */
  agentAnswers?: Record<string, string>;
}
