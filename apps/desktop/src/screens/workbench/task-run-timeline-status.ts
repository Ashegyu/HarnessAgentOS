import type { StepStatus, TaskRunStatus } from "@harness/core";
import type { StatusBadgeKind } from "./TaskRunStatusBadge";

export interface TaskRunTimelineBadge {
  status: TaskRunStatus;
  label?: string;
  kind?: StatusBadgeKind;
}

export const deriveTaskRunTimelineBadge = ({
  taskRunStatus,
  stepStatuses,
}: {
  taskRunStatus: TaskRunStatus;
  stepStatuses: readonly StepStatus[];
}): TaskRunTimelineBadge => {
  if (
    taskRunStatus === "ready_for_review" &&
    stepStatuses.length > 0 &&
    stepStatuses.every(isTerminalSuccessfulStepStatus)
  ) {
    return {
      status: taskRunStatus,
      label: "실행 완료",
      kind: "success",
    };
  }
  return { status: taskRunStatus };
};

const isTerminalSuccessfulStepStatus = (status: StepStatus): boolean =>
  status === "succeeded" || status === "skipped";
