import { assertTaskRunTransition, type TaskRun, type TaskRunStatus } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { OrchestrationError } from "./orchestration-types.ts";

/** Paused work can resume; a terminal or missing task cannot consume a plan. */
export const assertWorkerTaskEntry = (task: TaskRun | null): void => {
  if (!task || task.status === "cancelled" || task.status === "done") {
    throw new OrchestrationError(
      "ORCHESTRATION_TASK_NOT_RUNNABLE",
      `Cannot execute an orchestration plan for a ${task?.status ?? "missing"} task`,
    );
  }
};

/** Pause drains already-started workers, but never admits another worker. */
export const isWorkerTaskActive = (task: TaskRun | null): boolean =>
  task !== null && task.status !== "paused" && task.status !== "cancelled" && task.status !== "done";

/** Publish against the observed state so a concurrent Pause/Cancel wins. */
export const setActiveWorkerTaskStatus = async (
  state: LocalStateService,
  taskRunId: string,
  status: TaskRunStatus,
): Promise<TaskRun | null> => {
  const task = await state.getTaskRun(taskRunId);
  if (!task || !isWorkerTaskActive(task)) return task;
  assertTaskRunTransition(task.status, status);
  if (task.status === status) return task;
  try {
    return await state.taskRuns.updateStatus(taskRunId, status, task.status);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "TASK_RUN_STATE_CONFLICT") {
      const current = await state.getTaskRun(taskRunId);
      if (!isWorkerTaskActive(current)) return current;
    }
    throw error;
  }
};
