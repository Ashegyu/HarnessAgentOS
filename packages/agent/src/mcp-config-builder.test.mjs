import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexMcpConfigOverrides,
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

test("sanitizeServerName replaces whitespace and unsafe chars so the Codex key is CLI-safe", () => {
  // Codex expects the key under mcp_servers to be usable as a tool prefix —
  // spaces and `/` would surface in `mcp__<server>__<tool>` style names.
  assert.equal(sanitizeServerName("Filesystem MCP"), "filesystem_mcp");
  assert.equal(sanitizeServerName("Hosted/SSE!"), "hosted_sse");
  assert.equal(sanitizeServerName(""), "unnamed");
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
