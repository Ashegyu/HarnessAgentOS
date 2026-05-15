import type {
  AgentInvocationStatus,
  Approval,
  TaskRun,
  TaskRunStatus,
} from "@harness/core";
import type { StatusBadgeKind } from "./TaskRunStatusBadge";

export interface ChatTurnStatusBadge {
  status: TaskRunStatus;
  label?: string;
  kind?: StatusBadgeKind;
}

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

export const deriveChatTurnStatusBadge = (input: {
  taskRunStatus: TaskRunStatus;
  invocationStatus?: AgentInvocationStatus;
  approvals?: readonly Pick<Approval, "status">[];
  hasFinalAnswer: boolean;
}): ChatTurnStatusBadge => {
  const status = deriveChatTurnDisplayStatus(input);
  if (
    status === "ready_for_review" &&
    (input.hasFinalAnswer || input.invocationStatus === "succeeded")
  ) {
    return {
      status,
      label: "실행 완료",
      kind: "success",
    };
  }
  return { status };
};
