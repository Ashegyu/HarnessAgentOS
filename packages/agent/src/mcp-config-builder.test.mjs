import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexMcpConfigOverrides,
  buildClaudeMcpConfig,
  isMcpToolAllowed,
  sanitizeServerName,
} from "./mcp-config-builder.ts";

const STDIO = {
  id: "mcp_fs",
  name: "Filesystem MCP",
  description: "",
  transport: "stdio",
  command: "/usr/local/bin/mcp-fs",
  args: ["--root", "/tmp"],
  env: { LOG_LEVEL: "info" },
  envSecretRefs: { API_TOKEN: "fs_token_key" },
  scope: "global",
  enabled: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

const HTTP = {
  id: "mcp_remote",
  name: "Remote",
  description: "",
  transport: "http",
  url: "https://mcp.example.com/v1",
  env: {},
  envSecretRefs: { AUTH: "remote_bearer" },
  scope: "global",
  enabled: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

const SSE = {
  ...HTTP,
  id: "mcp_sse",
  name: "Hosted SSE",
  transport: "sse",
  url: "https://mcp.example.com/sse",
};

const fakeVault = (mapping) => async (key) => mapping[key] ?? null;

test("buildClaudeMcpConfig emits stdio block with merged env including resolved secrets", async () => {
  const cfg = await buildClaudeMcpConfig(
    [STDIO],
    fakeVault({ fs_token_key: "PLAINTEXT_TOKEN" }),
  );
  assert.deepEqual(cfg, {
    mcpServers: {
      // server names are sanitized so they're CLI-safe
      filesystem_mcp: {
        command: "/usr/local/bin/mcp-fs",
        args: ["--root", "/tmp"],
        env: { LOG_LEVEL: "info", API_TOKEN: "PLAINTEXT_TOKEN" },
      },
    },
  });
});

test("buildClaudeMcpConfig emits http transport with bearer header when AUTH ref resolves", async () => {
  const cfg = await buildClaudeMcpConfig(
    [HTTP],
    fakeVault({ remote_bearer: "abc123" }),
  );
  assert.deepEqual(cfg.mcpServers.remote, {
    type: "http",
    url: "https://mcp.example.com/v1",
    headers: { Authorization: "Bearer abc123" },
  });
});

test("buildClaudeMcpConfig emits sse transport", async () => {
  const cfg = await buildClaudeMcpConfig([SSE], fakeVault({ remote_bearer: "tok" }));
  assert.equal(cfg.mcpServers.hosted_sse.type, "sse");
  assert.equal(cfg.mcpServers.hosted_sse.url, "https://mcp.example.com/sse");
});

test("buildClaudeMcpConfig skips disabled servers", async () => {
  const cfg = await buildClaudeMcpConfig(
    [{ ...STDIO, enabled: false }],
    fakeVault({}),
  );
  assert.deepEqual(cfg, { mcpServers: {} });
});

test("buildClaudeMcpConfig fails fast when a secretRef cannot be resolved", async () => {
  await assert.rejects(
    () => buildClaudeMcpConfig([STDIO], fakeVault({})),
    /fs_token_key/,
  );
});

test("buildClaudeMcpConfig omits env block when there is nothing to inject", async () => {
  const minimal = { ...STDIO, env: {}, envSecretRefs: {} };
  const cfg = await buildClaudeMcpConfig([minimal], fakeVault({}));
  assert.equal(cfg.mcpServers.filesystem_mcp.env, undefined);
});

test("sanitizeServerName replaces whitespace and unsafe chars so the JSON key is CLI-safe", () => {
  // Claude expects the key under mcpServers to be usable as a tool prefix —
  // spaces and `/` would surface in `mcp__<server>__<tool>` style names.
  assert.equal(sanitizeServerName("Filesystem MCP"), "filesystem_mcp");
  assert.equal(sanitizeServerName("Hosted/SSE!"), "hosted_sse");
  assert.equal(sanitizeServerName(""), "unnamed");
});

test("buildClaudeMcpConfig handles two servers with name collisions by sanitizing+suffixing", async () => {
  const a = { ...STDIO, name: "Same Name" };
  const b = { ...STDIO, id: "mcp_b", name: "Same Name" };
  const cfg = await buildClaudeMcpConfig(
    [a, b],
    fakeVault({ fs_token_key: "x" }),
  );
  const keys = Object.keys(cfg.mcpServers);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], "same_name");
  assert.equal(keys[1], "same_name_2");
});

test("isMcpToolAllowed gives deny patterns priority over allow patterns", () => {
  const policy = {
    toolAllowlist: ["mcp__filesystem_mcp__*"],
    toolDenylist: ["mcp__filesystem_mcp__delete_*"],
  };
  assert.equal(isMcpToolAllowed("mcp__filesystem_mcp__read_file", policy), true);
  assert.equal(isMcpToolAllowed("mcp__filesystem_mcp__delete_file", policy), false);
  assert.equal(isMcpToolAllowed("mcp__remote__read_file", policy), false);
});

test("buildClaudeMcpConfig filters servers outside the profile tool allowlist", async () => {
  const cfg = await buildClaudeMcpConfig(
    [STDIO, HTTP],
    fakeVault({ fs_token_key: "PLAINTEXT_TOKEN", remote_bearer: "abc123" }),
    {
      toolAllowlist: ["mcp__filesystem_mcp__read_*"],
      toolDenylist: [],
    },
  );
  assert.deepEqual(Object.keys(cfg.mcpServers), ["filesystem_mcp"]);
});

test("buildClaudeMcpConfig skips a server namespace denied by profile policy even when allowed", async () => {
  const cfg = await buildClaudeMcpConfig(
    [STDIO],
    fakeVault({ fs_token_key: "PLAINTEXT_TOKEN" }),
    {
      toolAllowlist: ["mcp__filesystem_mcp__*"],
      toolDenylist: ["mcp__filesystem_mcp__*"],
    },
  );
  assert.deepEqual(cfg, { mcpServers: {} });
});

test("buildCodexMcpConfigOverrides emits stdio mcp_servers config overrides without secrets", () => {
  const cfg = buildCodexMcpConfigOverrides([
    { ...STDIO, envSecretRefs: {} },
  ]);

  assert.deepEqual(cfg, [
    'mcp_servers.filesystem_mcp.command="/usr/local/bin/mcp-fs"',
    'mcp_servers.filesystem_mcp.args=["--root", "/tmp"]',
    'mcp_servers.filesystem_mcp.env.LOG_LEVEL="info"',
  ]);
});

test("buildCodexMcpConfigOverrides filters server namespaces through tool policy", () => {
  const repo = {
    ...STDIO,
    id: "mcp_repo",
    name: "Repo MCP",
    env: {},
    envSecretRefs: {},
  };
  const blocked = {
    ...STDIO,
    id: "mcp_blocked",
    name: "Blocked MCP",
    env: {},
    envSecretRefs: {},
  };

  const cfg = buildCodexMcpConfigOverrides([repo, blocked], {
    toolAllowlist: ["mcp__repo_mcp__read_*"],
    toolDenylist: [],
  });

  assert.deepEqual(cfg, [
    'mcp_servers.repo_mcp.command="/usr/local/bin/mcp-fs"',
    'mcp_servers.repo_mcp.args=["--root", "/tmp"]',
  ]);
});

test("buildCodexMcpConfigOverrides rejects SecretVault refs to avoid argv secret exposure", () => {
  assert.throws(
    () => buildCodexMcpConfigOverrides([STDIO]),
    /SecretVault refs/,
  );
});

test("buildCodexMcpConfigOverrides rejects unverified remote transports", () => {
  assert.throws(
    () => buildCodexMcpConfigOverrides([{ ...HTTP, envSecretRefs: {} }]),
    /stdio MCP servers only/,
  );
});
