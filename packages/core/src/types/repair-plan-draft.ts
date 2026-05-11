import type { Approval } from "./approval.ts";
import type { Artifact } from "./artifact.ts";
import type { Checkpoint } from "./checkpoint.ts";
import type { TaskRun } from "./task-run.ts";

export interface RepairPlanDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}
