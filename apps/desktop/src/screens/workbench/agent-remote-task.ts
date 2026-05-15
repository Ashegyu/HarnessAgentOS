import type { A2ARemoteTaskRef } from "@harness/core";

export const remoteTaskForInvocation = (
  refs: readonly A2ARemoteTaskRef[],
  invocationId: string,
): A2ARemoteTaskRef | null =>
  refs.find((ref) => ref.invocationId === invocationId) ?? null;

export const formatRemoteTaskLabel = (ref: A2ARemoteTaskRef): string =>
  `A2A ${ref.state}${ref.remoteTaskId ? ` · ${ref.remoteTaskId}` : ""}`;

export const remoteTaskNeedsAttention = (ref: A2ARemoteTaskRef): boolean =>
  ref.state === "input-required" || ref.state === "auth-required";

export const remoteTaskAttentionLabel = (
  ref: A2ARemoteTaskRef,
): string | null => {
  if (ref.state === "input-required") return "사용자 입력 필요";
  if (ref.state === "auth-required") return "인증 설정 필요";
  return null;
};

export const remoteTaskTitle = (ref: A2ARemoteTaskRef): string => {
  const parts = [`endpoint ${ref.endpointId}`];
  if (ref.remoteContextId) parts.push(`context ${ref.remoteContextId}`);
  if (ref.lastEventAt) parts.push(ref.lastEventAt);
  return parts.join(" · ");
};
