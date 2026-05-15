import type { A2ARemoteTaskRef } from "@harness/core";

export const remoteTaskForInvocation = (
  refs: readonly A2ARemoteTaskRef[],
  invocationId: string,
): A2ARemoteTaskRef | null =>
  refs.find((ref) => ref.invocationId === invocationId) ?? null;

export const formatRemoteTaskLabel = (ref: A2ARemoteTaskRef): string =>
  `A2A ${ref.state}${ref.remoteTaskId ? ` · ${ref.remoteTaskId}` : ""}`;

export const remoteTaskTitle = (ref: A2ARemoteTaskRef): string => {
  const parts = [`endpoint ${ref.endpointId}`];
  if (ref.remoteContextId) parts.push(`context ${ref.remoteContextId}`);
  if (ref.lastEventAt) parts.push(ref.lastEventAt);
  return parts.join(" · ");
};
