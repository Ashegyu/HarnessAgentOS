import type { AgentStreamEvent, TaskRun } from "@harness/core";

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
  if (!refreshesTaskRunDetail(input.eventType)) return null;
  if (input.eventTaskRunId) return input.eventTaskRunId;
  if (!input.selectedTaskRunId) return null;
  return input.selectedTaskRunId;
};

export const taskRunIdFromAgentStreamEvent = (
  event: AgentStreamEvent,
): string | undefined => {
  const taskRunId = event.taskRunId;
  return typeof taskRunId === "string" && taskRunId.length > 0
    ? taskRunId
    : undefined;
};

const refreshesTaskRunDetail = (eventType: string): boolean =>
  eventType === "progress" ||
  eventType === "started" ||
  eventType === "result" ||
  eventType === "failed" ||
  eventType === "cancelled";
