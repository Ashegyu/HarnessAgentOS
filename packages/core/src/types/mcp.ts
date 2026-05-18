/**
 * MCP (Model Context Protocol) server configuration — see
 * docs/design/agent-detailed-settings.md §4.2.
 *
 * Stored in the `mcp_servers` table. Profiles reference servers by id
 * via AgentProfile.mcpServerIds. SecretVault keys live in envSecretRefs;
 * plaintext values stay out of this row entirely.
 */

export type McpTransport = "stdio" | "http" | "sse";

export const MCP_TRANSPORTS: readonly McpTransport[] = [
  "stdio",
  "http",
  "sse",
];

export type McpScope = "global" | "per-agent";

export const MCP_SCOPES: readonly McpScope[] = ["global", "per-agent"];

export interface McpServerHealth {
  /** ISO8601 of the last successful health check. */
  okAt?: string;
  /** Last error message if the most recent check failed. */
  error?: string;
  /** ISO8601 of the most recent check (regardless of outcome). */
  checkedAt: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  transport: McpTransport;
  /** stdio only: executable path. */
  command?: string;
  args?: readonly string[];
  /** http/sse only: endpoint URL. */
  url?: string;
  env: Readonly<Record<string, string>>;
  envSecretRefs: Readonly<Record<string, string>>;
  scope: McpScope;
  enabled: boolean;
  lastHealth?: McpServerHealth;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerConfigDraft {
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: readonly string[];
  url?: string;
  env: Readonly<Record<string, string>>;
  envSecretRefs: Readonly<Record<string, string>>;
  scope: McpScope;
  enabled: boolean;
}

export interface McpServerGenerationRequest {
  userIntent: string;
  preferredTransport?: McpTransport;
  profileIds?: readonly string[];
}

export interface GeneratedMcpServerDraft extends McpServerConfigDraft {
  recommendedProfileIds: string[];
  secretPlaceholders: string[];
  rationale: string;
}

export interface McpServerDraftPreviewIssue {
  field:
    | keyof McpServerConfigDraft
    | "content"
    | "envSecretRefs";
  message: string;
}

export interface McpServerDraftPreview {
  ok: boolean;
  errors: McpServerDraftPreviewIssue[];
  warnings: string[];
  server: McpServerConfigDraft;
  wouldNameCollide: boolean;
  sanitizedConfigKey: string;
}

export interface McpServerGenerationPreviewResult {
  draft: GeneratedMcpServerDraft;
  preview: McpServerDraftPreview;
}

const TRANSPORT_SET: ReadonlySet<string> = new Set(MCP_TRANSPORTS);
const SCOPE_SET: ReadonlySet<string> = new Set(MCP_SCOPES);

export const isMcpTransport = (v: unknown): v is McpTransport =>
  typeof v === "string" && TRANSPORT_SET.has(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const isStringRecord = (v: unknown): v is Record<string, string> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((val) => typeof val === "string");
};

const isHealth = (v: unknown): v is McpServerHealth => {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  if (typeof h.checkedAt !== "string") return false;
  if (h.okAt !== undefined && typeof h.okAt !== "string") return false;
  if (h.error !== undefined && typeof h.error !== "string") return false;
  return true;
};

export const isMcpServerConfig = (v: unknown): v is McpServerConfig => {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== "string") return false;
  if (typeof c.name !== "string") return false;
  if (typeof c.description !== "string") return false;
  if (!isMcpTransport(c.transport)) return false;
  if (typeof c.scope !== "string" || !SCOPE_SET.has(c.scope)) return false;
  if (typeof c.enabled !== "boolean") return false;
  if (!isStringRecord(c.env)) return false;
  if (!isStringRecord(c.envSecretRefs)) return false;
  if (typeof c.createdAt !== "string") return false;
  if (typeof c.updatedAt !== "string") return false;

  // Transport-specific shape: stdio needs command, http/sse needs url.
  if (c.transport === "stdio") {
    if (typeof c.command !== "string" || c.command.length === 0) return false;
    if (c.args !== undefined && !isStringArray(c.args)) return false;
  } else {
    if (typeof c.url !== "string" || c.url.length === 0) return false;
  }

  if (c.lastHealth !== undefined && !isHealth(c.lastHealth)) return false;
  return true;
};
