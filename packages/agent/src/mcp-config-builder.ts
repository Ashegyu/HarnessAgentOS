import type { McpServerConfig } from "@harness/core";

/**
 * Phase 4b — Compose the `.mcp.json` payload that Claude CLI receives
 * via `--mcp-config`. Codex per-invocation MCP config is still unverified,
 * so the main process does not call this builder for Codex invocations.
 * Output mirrors the Claude-compatible format:
 *
 *   stdio  → { command, args?, env? }
 *   http   → { type: "http",  url, headers? }
 *   sse    → { type: "sse",   url, headers? }
 *
 * Plaintext for envSecretRefs is resolved here against the supplied
 * SecretLookup. Renderer never participates in this resolution — the
 * builder runs in the main process at spawn time.
 */

export interface ClaudeMcpStdioBlock {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

export interface ClaudeMcpHttpBlock {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type ClaudeMcpServerBlock = ClaudeMcpStdioBlock | ClaudeMcpHttpBlock;

export interface ClaudeMcpConfigFile {
  mcpServers: Record<string, ClaudeMcpServerBlock>;
}

/**
 * Resolves a SecretVault key to its plaintext. Returns null when the key
 * is unknown, in which case `buildClaudeMcpConfig` throws — we'd rather
 * fail loudly than silently spawn an MCP server missing its credential.
 */
export type SecretLookup = (key: string) => Promise<string | null>;

const NAME_PATTERN = /[^a-z0-9_]/g;

export const sanitizeServerName = (raw: string): string => {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
  const cleaned = normalized.replace(NAME_PATTERN, "_").replace(/_+/g, "_");
  const trimmed = cleaned.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "unnamed";
};

const allocateKey = (
  taken: Set<string>,
  base: string,
): string => {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  const key = `${base}_${i}`;
  taken.add(key);
  return key;
};

export const buildClaudeMcpConfig = async (
  servers: readonly McpServerConfig[],
  resolveSecret: SecretLookup,
): Promise<ClaudeMcpConfigFile> => {
  const out: Record<string, ClaudeMcpServerBlock> = {};
  const taken = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;

    const resolvedSecrets: Record<string, string> = {};
    for (const [envName, vaultKey] of Object.entries(server.envSecretRefs)) {
      const plain = await resolveSecret(vaultKey);
      if (plain === null) {
        throw new Error(
          `MCP server "${server.name}": secret vault key "${vaultKey}" could not be resolved (referenced by env "${envName}")`,
        );
      }
      resolvedSecrets[envName] = plain;
    }

    const key = allocateKey(taken, sanitizeServerName(server.name));

    if (server.transport === "stdio") {
      const env: Record<string, string> = { ...server.env, ...resolvedSecrets };
      const block: ClaudeMcpStdioBlock = {
        command: server.command ?? "",
      };
      if (server.args && server.args.length > 0) {
        block.args = [...server.args];
      }
      if (Object.keys(env).length > 0) {
        block.env = env;
      }
      out[key] = block;
    } else {
      const headers: Record<string, string> = { ...server.env };
      if (resolvedSecrets["AUTH"] !== undefined) {
        headers["Authorization"] = `Bearer ${resolvedSecrets["AUTH"]}`;
        delete resolvedSecrets["AUTH"];
      }
      for (const [k, v] of Object.entries(resolvedSecrets)) {
        headers[k] = v;
      }
      const block: ClaudeMcpHttpBlock = {
        type: server.transport,
        url: server.url ?? "",
      };
      if (Object.keys(headers).length > 0) {
        block.headers = headers;
      }
      out[key] = block;
    }
  }

  return { mcpServers: out };
};
