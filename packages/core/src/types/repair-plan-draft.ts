import type { Approval } from "./approval";
import type { Artifact } from "./artifact";
import type { Checkpoint } from "./checkpoint";
import type { TaskRun } from "./task-run";

export interface RepairPlanDraft {
  taskRun: TaskRun;
  planArtifact: Artifact;
  checkpoint: Checkpoint;
  approvals: Approval[];
}
