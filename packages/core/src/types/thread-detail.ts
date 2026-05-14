import type { Thread } from "./thread.ts";
import type { TaskRun } from "./task-run.ts";

export interface ThreadDetail {
  thread: Thread;
  taskRuns: TaskRun[];
  /**
   * taskRunId → latest persisted agent answer stream/output, when present.
   * Lets the conversation workbench render an agent reply bubble next to
   * each user request without doing N additional IPC round-trips. Older
   * runs may fall back to the latest plan artifact summary.
   */
  agentAnswers?: Record<string, string>;
}
