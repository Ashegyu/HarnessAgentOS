import type { TaskRun } from "@harness/core";

export const shouldRenderAgentPanel = (input: {
  taskRunStatus: TaskRun["status"];
  invocationCount: number;
  handoffCount: number;
  orchestrationDriven: boolean;
}): boolean => {
  if (input.invocationCount > 0) return true;
  if (input.handoffCount > 0) return true;
  if (input.taskRunStatus !== "drafting") return false;
  return !input.orchestrationDriven;
};

export const taskRunIdToRefreshForAgentEvent = (input: {
  eventType: string;
  selectedTaskRunId: string | null;
  eventTaskRunId?: string;
}): string | null => {
  if (input.eventTaskRunId) return input.eventTaskRunId;
  if (!input.selectedTaskRunId) return null;
  return input.eventType === "started" ||
    input.eventType === "result" ||
    input.eventType === "failed" ||
    input.eventType === "cancelled"
    ? input.selectedTaskRunId
    : null;
};
