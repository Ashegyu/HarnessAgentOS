import { taskContractFor, type TaskRun } from "@harness/core";

export const defaultQualityRequirements = (task: Pick<TaskRun, "userRequest" | "contract">) => ({
  requireBuild: false,
  requireTests: taskContractFor(task).authorization.mode !== "read_only",
  requireSmoke: false,
});
