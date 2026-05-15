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

export interface A2ARemoteTaskRef {
  invocationId: string;
  endpointId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  state: A2ARemoteTaskState;
  lastEventAt?: string;
}

