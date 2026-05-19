import type { AgentPermissions, McpServerConfig } from "@harness/core";

/**
 * Phase 4b — Compose provider-specific MCP config for one invocation.
 *
 * Claude receives a temporary `.mcp.json` path via `--mcp-config`. Output
 * mirrors the Claude-compatible format:
 *
 *   stdio  → { command, args?, env? }
 *   http   → { type: "http",  url, headers? }
 *   sse    → { type: "sse",   url, headers? }
 *
 * Codex receives verified per-run config overrides through repeated
 * `-c mcp_servers.<name>.*=...` flags. That path is intentionally limited
 * to stdio servers without SecretVault refs: `-c` values are visible in
 * process argv, so plaintext secrets must not be encoded there.
 *
 * Plaintext for envSecretRefs is resolved here against the supplied
 * SecretLookup for Claude only. Renderer never participates in this
 * resolution — the builder runs in the main process at spawn time.
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

export type McpToolPolicy = Pick<
  AgentPermissions,
  "toolAllowlist" | "toolDenylist"
>;

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
  toolPolicy?: McpToolPolicy,
): Promise<ClaudeMcpConfigFile> => {
  const out: Record<string, ClaudeMcpServerBlock> = {};
  const taken = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;
    const baseKey = sanitizeServerName(server.name);
    if (!isMcpServerAllowedByToolPolicy(baseKey, toolPolicy)) continue;

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

    const key = allocateKey(taken, baseKey);

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

export const buildCodexMcpConfigOverrides = (
  servers: readonly McpServerConfig[],
  toolPolicy?: McpToolPolicy,
): string[] => {
  const out: string[] = [];
  const taken = new Set<string>();

  for (const server of servers) {
    if (!server.enabled) continue;
    const baseKey = sanitizeServerName(server.name);
    if (!isMcpServerAllowedByToolPolicy(baseKey, toolPolicy)) continue;

    if (server.transport !== "stdio") {
      throw new Error(
        `Codex per-invocation MCP config currently supports stdio MCP servers only: "${server.name}" uses ${server.transport}.`,
      );
    }
    const secretNames = Object.keys(server.envSecretRefs);
    if (secretNames.length > 0) {
      throw new Error(
        `MCP server "${server.name}": Codex per-invocation MCP config cannot safely use SecretVault refs (${secretNames.join(", ")}) because -c values are process argv.`,
      );
    }
    const command = server.command?.trim();
    if (!command) {
      throw new Error(
        `MCP server "${server.name}": Codex stdio MCP config requires a command.`,
      );
    }

    const key = allocateKey(taken, baseKey);
    out.push(`mcp_servers.${key}.command=${tomlString(command)}`);
    if (server.args && server.args.length > 0) {
      out.push(`mcp_servers.${key}.args=${tomlArray(server.args)}`);
    }
    for (const [envName, value] of Object.entries(server.env).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      out.push(
        `mcp_servers.${key}.env.${tomlKey(envName)}=${tomlString(value)}`,
      );
    }
  }

  return out;
};

export const isMcpToolAllowed = (
  toolName: string,
  policy: McpToolPolicy | undefined,
): boolean => {
  const normalized = toolName.trim();
  if (normalized.length === 0) return false;
  const deny = normalizePatterns(policy?.toolDenylist);
  if (deny.some((pattern) => globMatches(pattern, normalized))) {
    return false;
  }
  const allow = normalizePatterns(policy?.toolAllowlist);
  return (
    allow.length === 0 ||
    allow.some((pattern) => globMatches(pattern, normalized))
  );
};

const isMcpServerAllowedByToolPolicy = (
  serverKey: string,
  policy: McpToolPolicy | undefined,
): boolean => {
  const samples = toolNamespaceSamples(serverKey);
  const deny = normalizePatterns(policy?.toolDenylist);
  if (
    deny.some((pattern) =>
      samples.every((toolName) => globMatches(pattern, toolName)),
    )
  ) {
    return false;
  }
  const allow = normalizePatterns(policy?.toolAllowlist);
  return (
    allow.length === 0 ||
    allow.some((pattern) =>
      samples.some((toolName) => globMatches(pattern, toolName)),
    )
  );
};

const toolNamespaceSamples = (serverKey: string): string[] => {
  const prefix = `mcp__${serverKey}__`;
  return [
    `${prefix}list`,
    `${prefix}read_file`,
    `${prefix}write_file`,
    `${prefix}delete_file`,
  ];
};

const normalizePatterns = (
  patterns: readonly string[] | undefined,
): string[] => {
  if (!patterns) return [];
  return patterns.map((p) => p.trim()).filter((p) => p.length > 0);
};

const globMatches = (pattern: string, value: string): boolean =>
  globToRegExp(pattern).test(value);

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
};

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

const tomlKey = (value: string): string =>
  TOML_BARE_KEY.test(value) ? value : tomlString(value);

const tomlString = (value: string): string => JSON.stringify(value);

const tomlArray = (values: readonly string[]): string =>
  `[${values.map((value) => tomlString(value)).join(", ")}]`;
