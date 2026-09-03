import type {
  GeneratedMcpServerDraft,
  McpServerConfig,
  McpTransport,
} from "@harness/core";

export const MCP_PROVIDER_BOUNDARY_TEXT =
  "Codex는 stdio/no-secret 서버만 per-run -c mcp_servers.* override로 연결합니다. SecretVault refs 또는 http/sse remote transport는 Codex CLI 실행 전에 차단됩니다.";

/**
 * Form state for the MCP server editor. Mirrors the runtime
 * McpServerConfig shape but uses string fields throughout so the user
 * can type partial input without the radio/select forcing a coerced
 * value. Serializer reads the right fields based on `transport`.
 */
export interface ServerDraft {
  id: string | null;
  name: string;
  description: string;
  transport: McpTransport;
  /** stdio only */
  command: string;
  /** Whitespace-separated args. Empty string = no args. */
  argsText: string;
  /** http/sse only */
  url: string;
  /** "KEY=value" rows, one per line, blank lines ignored. */
  envText: string;
  /** "ENV_NAME=secret_vault_key" rows, one per line. */
  envSecretRefsText: string;
  scope: McpServerConfig["scope"];
  enabled: boolean;
}

export const emptyServerDraft = (): ServerDraft => ({
  id: null,
  name: "",
  description: "",
  transport: "stdio",
  command: "",
  argsText: "",
  url: "",
  envText: "",
  envSecretRefsText: "",
  scope: "global",
  enabled: true,
});

const recordToText = (r: Readonly<Record<string, string>>): string =>
  Object.entries(r)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

const textToRecord = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // skip malformed; surfaced via validation
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
};

export const serverDraftFromConfig = (c: McpServerConfig): ServerDraft => ({
  id: c.id,
  name: c.name,
  description: c.description,
  transport: c.transport,
  command: c.command ?? "",
  argsText: (c.args ?? []).join(" "),
  url: c.url ?? "",
  envText: recordToText(c.env),
  envSecretRefsText: recordToText(c.envSecretRefs),
  scope: c.scope,
  enabled: c.enabled,
});

export const mcpGeneratedDraftToFormDraft = (
  draft: GeneratedMcpServerDraft,
): ServerDraft => ({
  id: null,
  name: draft.name,
  description: draft.description,
  transport: draft.transport,
  command: draft.command ?? "",
  argsText: (draft.args ?? []).join(" "),
  url: draft.url ?? "",
  envText: recordToText(draft.env),
  envSecretRefsText: recordToText(draft.envSecretRefs),
  scope: draft.scope,
  enabled: draft.enabled,
});

export interface ServerDraftError {
  field: keyof ServerDraft;
  message: string;
}

export const validateServerDraft = (
  draft: ServerDraft,
): ServerDraftError[] => {
  const errors: ServerDraftError[] = [];
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  if (draft.transport === "stdio") {
    if (draft.command.trim().length === 0) {
      errors.push({
        field: "command",
        message: "stdio transport는 command가 필수입니다",
      });
    }
  } else {
    const url = draft.url.trim();
    if (url.length === 0) {
      errors.push({
        field: "url",
        message: `${draft.transport} transport는 URL이 필수입니다`,
      });
    } else if (!/^https?:\/\//i.test(url)) {
      errors.push({
        field: "url",
        message: "URL은 http:// 또는 https:// 로 시작해야 합니다",
      });
    }
  }
  // env / envSecretRefs: each non-blank line must have a single '=' with a
  // non-empty key. Empty values are allowed (e.g. "FLAG=").
  const lintRecord = (
    text: string,
    field: "envText" | "envSecretRefsText",
    label: string,
  ): void => {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? "").trim();
      if (line.length === 0) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) {
        errors.push({
          field,
          message: `${label} 라인 ${i + 1}: "KEY=VALUE" 형식이어야 합니다`,
        });
      }
    }
  };
  lintRecord(draft.envText, "envText", "env");
  lintRecord(draft.envSecretRefsText, "envSecretRefsText", "envSecretRefs");

  return errors;
};

/**
 * Serialize to the IPC payload shape. Caller should run
 * `validateServerDraft` first; behavior on invalid input is best-effort.
 */
export const serializeServerDraft = (
  draft: ServerDraft,
): Omit<McpServerConfig, "createdAt" | "updatedAt"> => {
  const env = textToRecord(draft.envText);
  const envSecretRefs = textToRecord(draft.envSecretRefsText);
  const base: Omit<McpServerConfig, "createdAt" | "updatedAt"> = {
    id: draft.id ?? "mcp_placeholder",
    name: draft.name.trim(),
    description: draft.description,
    transport: draft.transport,
    env,
    envSecretRefs,
    scope: draft.scope,
    enabled: draft.enabled,
  };
  if (draft.transport === "stdio") {
    base.command = draft.command.trim();
    const args = draft.argsText
      .split(/\s+/)
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    if (args.length > 0) base.args = args;
  } else {
    base.url = draft.url.trim();
  }
  return base;
};
