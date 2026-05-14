import type {
  AgentInvocationStatus,
  Approval,
  TaskRun,
  TaskRunStatus,
} from "@harness/core";

export const taskRunWithActiveOverride = (
  taskRun: TaskRun,
  activeTaskRun: TaskRun | null,
): TaskRun => (activeTaskRun?.id === taskRun.id ? activeTaskRun : taskRun);

export const deriveChatTurnDisplayStatus = ({
  taskRunStatus,
  invocationStatus,
  approvals,
}: {
  taskRunStatus: TaskRunStatus;
  invocationStatus?: AgentInvocationStatus;
  approvals?: readonly Pick<Approval, "status">[];
}): TaskRunStatus => {
  if (taskRunStatus !== "running") return taskRunStatus;
  if (invocationStatus === "failed") return "blocked";
  if (invocationStatus === "cancelled") return "cancelled";
  if (invocationStatus !== "succeeded") return taskRunStatus;
  return approvals?.some((approval) => approval.status === "pending")
    ? "waiting_for_approval"
    : "ready_for_review";
};
