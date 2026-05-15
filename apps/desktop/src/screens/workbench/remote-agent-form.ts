import type { A2AEndpoint, A2AEndpointDraft, A2ATransport } from "@harness/core";

export interface RemoteAgentDraft {
  id: string | null;
  name: string;
  baseUrl: string;
  agentCardUrl: string;
  preferredTransport: A2ATransport;
  enabled: boolean;
  trusted: boolean;
  authSecretRef: string;
  createdAt?: string;
  updatedAt?: string;
}

export const emptyRemoteAgentDraft = (): RemoteAgentDraft => ({
  id: null,
  name: "",
  baseUrl: "",
  agentCardUrl: "",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: false,
  authSecretRef: "",
});

export const remoteAgentDraftFromEndpoint = (
  endpoint: A2AEndpoint,
): RemoteAgentDraft => ({
  id: endpoint.id,
  name: endpoint.name,
  baseUrl: endpoint.baseUrl,
  agentCardUrl: endpoint.agentCardUrl,
  preferredTransport: endpoint.preferredTransport,
  enabled: endpoint.enabled,
  trusted: endpoint.trusted,
  authSecretRef: endpoint.authSecretRef ?? "",
  createdAt: endpoint.createdAt,
  updatedAt: endpoint.updatedAt,
});

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isLocalHttp = (url: URL): boolean =>
  url.protocol === "http:" &&
  (url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]");

const validateEndpointUrl = (
  label: string,
  value: string,
  trusted: boolean,
): string | null => {
  const parsed = parseUrl(value.trim());
  if (!parsed) return `${label}은 올바른 URL이어야 합니다.`;
  if (parsed.protocol === "https:") return null;
  if (isLocalHttp(parsed) && trusted) return null;
  if (isLocalHttp(parsed)) {
    return `${label}의 localhost http URL은 신뢰된 endpoint에서만 허용됩니다.`;
  }
  return `${label}은 https:// URL이어야 합니다.`;
};

export const validateRemoteAgentDraft = (
  draft: RemoteAgentDraft,
): string[] => {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) errors.push("이름은 필수입니다.");
  if (draft.baseUrl.trim().length === 0) {
    errors.push("Base URL은 필수입니다.");
  } else {
    const urlError = validateEndpointUrl(
      "Base URL",
      draft.baseUrl,
      draft.trusted,
    );
    if (urlError) errors.push(urlError);
  }
  if (draft.agentCardUrl.trim().length === 0) {
    errors.push("Agent Card URL은 필수입니다.");
  } else {
    const urlError = validateEndpointUrl(
      "Agent Card URL",
      draft.agentCardUrl,
      draft.trusted,
    );
    if (urlError) errors.push(urlError);
  }
  return errors;
};

export const serializeRemoteAgentDraft = (
  draft: RemoteAgentDraft,
): A2AEndpoint | A2AEndpointDraft => {
  const base: A2AEndpointDraft = {
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    agentCardUrl: draft.agentCardUrl.trim(),
    preferredTransport: draft.preferredTransport,
    enabled: draft.enabled,
    trusted: draft.trusted,
  };
  const secretRef = draft.authSecretRef.trim();
  if (secretRef.length > 0) base.authSecretRef = secretRef;
  if (draft.id === null) return base;
  return {
    ...base,
    id: draft.id,
    createdAt: draft.createdAt ?? new Date(0).toISOString(),
    updatedAt: draft.updatedAt ?? new Date(0).toISOString(),
  };
};

