import type { AgentInvocation, Step } from "@harness/core";

export interface AgentInvocationDisplayDescription {
  agentName: string;
  detail: string;
  providerLabel: string;
}

const invocationTime = (invocation: AgentInvocation): number => {
  const parsed = Date.parse(invocation.createdAt);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
};

export const orderedAgentInvocationsForDisplay = (
  invocations: readonly AgentInvocation[],
): AgentInvocation[] =>
  [...invocations].sort((a, b) => {
    const byCreatedAt = invocationTime(a) - invocationTime(b);
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  });

export const latestAgentInvocationForDisplay = (
  invocations: readonly AgentInvocation[],
): AgentInvocation | undefined => {
  const ordered = orderedAgentInvocationsForDisplay(invocations);
  return ordered[ordered.length - 1];
};

export const describeAgentInvocationForDisplay = (
  invocation: AgentInvocation,
  steps: readonly Step[],
): AgentInvocationDisplayDescription => {
  const providerLabel = `${invocation.provider}:${invocation.model}`;
  const step = invocation.stepId
    ? steps.find((candidate) => candidate.id === invocation.stepId)
    : undefined;
  if (!step) {
    return {
      agentName: providerLabel,
      detail: "Agent invocation",
      providerLabel,
    };
  }

  const worker = /^Worker\[([^\]]+)\]\s*(.*)$/.exec(step.title);
  if (worker) {
    const agentName = worker[1]?.trim() || step.title;
    const detail = worker[2]?.trim() || step.title;
    return { agentName, detail, providerLabel };
  }

  return {
    agentName: step.title,
    detail: providerLabel,
    providerLabel,
  };
};
