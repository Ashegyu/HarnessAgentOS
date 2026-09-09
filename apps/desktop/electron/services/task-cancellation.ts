import type { ConversationService } from "@harness/core";
import type { AgentPlanningService } from "@harness/agent";
import type { RunnerService } from "@harness/runners";

/** Persist the terminal state before stopping owners, so new claims are refused. */
export const cancelTaskAndExecutions = async (
  input: Parameters<ConversationService["cancelTask"]>[0],
  deps: {
    conversation: Pick<ConversationService, "cancelTask">;
    agentPlanning?: Pick<AgentPlanningService, "cancelTaskInvocations">;
    runner?: Pick<RunnerService, "cancelExecution">;
    changed: (taskRunId: string) => void;
  },
) => {
  const task = await deps.conversation.cancelTask(input);
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => deps.agentPlanning?.cancelTaskInvocations({ taskRunId: task.id })),
      Promise.resolve().then(() => deps.runner?.cancelExecution({ taskRunId: task.id })),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return task;
  } finally {
    deps.changed(task.id);
  }
};
