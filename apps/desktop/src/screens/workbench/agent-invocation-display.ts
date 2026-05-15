import type { AgentInvocation } from "@harness/core";

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
