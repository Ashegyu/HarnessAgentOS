export type A2ATransport = "json-rpc" | "http-json" | "grpc";

export type A2ARemoteTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
  | "unknown";

export interface A2ASkillSnapshot {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
}

export interface A2AEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  agentCardUrl: string;
  preferredTransport: A2ATransport;
  enabled: boolean;
  trusted: boolean;
  authSecretRef?: string;
  createdAt: string;
  updatedAt: string;
}

export type A2AEndpointDraft = Omit<A2AEndpoint, "id" | "createdAt" | "updatedAt">;

export interface A2AAgentCardSnapshot {
  endpointId: string;
  protocolVersion?: string;
  agentName: string;
  description?: string;
  version?: string;
  skills: readonly A2ASkillSnapshot[];
  inputModes: readonly string[];
  outputModes: readonly string[];
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  fetchedAt: string;
  etag?: string;
  rawCardJson: string;
}

export interface A2ARegistryEntry {
  endpoint: A2AEndpoint;
  card?: A2AAgentCardSnapshot;
}

export interface A2ARemoteTaskRef {
  invocationId: string;
  endpointId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  state: A2ARemoteTaskState;
  lastEventAt?: string;
}

export type A2ARefinementStatus =
  | "pending_approval"
  | "queued"
  | "running"
  | "input_required"
  | "auth_required"
  | "succeeded"
  | "failed"
  | "stopped"
  | "cancelled";

export type A2ARefinementFeedbackSourceKind =
  | "user"
  | "quality_gate"
  | "worker"
  | "system";

export type A2ARefinementStopReason =
  | "max_attempts_for_signature"
  | "max_attempts_for_task_run"
  | "repeated_feedback_signature"
  | "endpoint_unavailable"
  | "context_rejected_by_endpoint"
  | "missing_remote_task_ref"
  | "user_cancelled"
  | "auth_required"
  | "input_required";

export interface A2ARefinementTarget {
  invocationId: string;
  endpointId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  artifactIds: readonly string[];
}

export interface A2ARefinementRequest {
  taskRunId: string;
  targetInvocationId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: readonly string[];
}

export interface A2ARefinementAttempt {
  id: string;
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  referenceTaskIds: readonly string[];
  referenceArtifactIds: readonly string[];
  feedbackSignature: string;
  attemptIndex: number;
  status: A2ARefinementStatus;
  stopReason?: A2ARefinementStopReason;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type A2ARefinementProposalSourceKind =
  | "worker_finding"
  | "quality_gate";

export interface A2ARefinementProposal {
  id: string;
  sourceKind: A2ARefinementProposalSourceKind;
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: readonly string[];
  sourceLabel: string;
  targetLabel: string;
  reason: string;
}

export const A2A_TRANSPORTS: readonly A2ATransport[] = [
  "json-rpc",
  "http-json",
  "grpc",
];

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasOptionalString = (
  obj: Record<string, unknown>,
  key: string,
): boolean => obj[key] === undefined || typeof obj[key] === "string";

export const isA2AEndpointDraft = (v: unknown): v is A2AEndpointDraft => {
  if (!isRecord(v)) return false;
  return (
    typeof v.name === "string" &&
    typeof v.baseUrl === "string" &&
    typeof v.agentCardUrl === "string" &&
    typeof v.preferredTransport === "string" &&
    A2A_TRANSPORTS.includes(v.preferredTransport as A2ATransport) &&
    typeof v.enabled === "boolean" &&
    typeof v.trusted === "boolean" &&
    hasOptionalString(v, "authSecretRef")
  );
};

export const isA2AEndpoint = (v: unknown): v is A2AEndpoint => {
  if (!isRecord(v) || !isA2AEndpointDraft(v)) return false;
  const endpoint = v as Record<string, unknown>;
  return (
    typeof endpoint.id === "string" &&
    typeof endpoint.createdAt === "string" &&
    typeof endpoint.updatedAt === "string"
  );
};

const isA2ASkillSnapshot = (v: unknown): v is A2ASkillSnapshot => {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    isStringArray(v.tags)
  );
};

const isA2ACapabilities = (
  v: unknown,
): v is A2AAgentCardSnapshot["capabilities"] => {
  if (!isRecord(v)) return false;
  for (const key of ["streaming", "pushNotifications", "stateTransitionHistory"]) {
    if (v[key] !== undefined && typeof v[key] !== "boolean") return false;
  }
  return true;
};

export const isA2AAgentCardSnapshot = (
  v: unknown,
): v is A2AAgentCardSnapshot => {
  if (!isRecord(v)) return false;
  return (
    typeof v.endpointId === "string" &&
    hasOptionalString(v, "protocolVersion") &&
    typeof v.agentName === "string" &&
    hasOptionalString(v, "description") &&
    hasOptionalString(v, "version") &&
    Array.isArray(v.skills) &&
    v.skills.every(isA2ASkillSnapshot) &&
    isStringArray(v.inputModes) &&
    isStringArray(v.outputModes) &&
    isA2ACapabilities(v.capabilities) &&
    typeof v.fetchedAt === "string" &&
    hasOptionalString(v, "etag") &&
    typeof v.rawCardJson === "string"
  );
};

export const A2A_REFINEMENT_STATUSES: readonly A2ARefinementStatus[] = [
  "pending_approval",
  "queued",
  "running",
  "input_required",
  "auth_required",
  "succeeded",
  "failed",
  "stopped",
  "cancelled",
];

export const A2A_REFINEMENT_FEEDBACK_SOURCE_KINDS: readonly A2ARefinementFeedbackSourceKind[] =
  ["user", "quality_gate", "worker", "system"];

export const isA2ARefinementRequest = (
  v: unknown,
): v is A2ARefinementRequest => {
  if (!isRecord(v)) return false;
  return (
    typeof v.taskRunId === "string" &&
    typeof v.targetInvocationId === "string" &&
    typeof v.feedbackSourceKind === "string" &&
    A2A_REFINEMENT_FEEDBACK_SOURCE_KINDS.includes(
      v.feedbackSourceKind as A2ARefinementFeedbackSourceKind,
    ) &&
    hasOptionalString(v, "feedbackSourceStepId") &&
    hasOptionalString(v, "feedbackSourceInvocationId") &&
    hasOptionalString(v, "feedbackArtifactId") &&
    hasOptionalString(v, "qualityGateId") &&
    typeof v.instruction === "string" &&
    isStringArray(v.referencedArtifactIds)
  );
};
