import type { Approval } from "./approval.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { TaskRun } from "./task-run.ts";
import type { Thread } from "./thread.ts";

export interface ExportApprovalResult {
  thread: Thread;
  taskRun: TaskRun;
  checkpoint: Checkpoint;
  approval: Approval;
  targetPath: string;
}
