import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCP_TRANSPORTS,
  MCP_SCOPES,
  isMcpServerConfig,
  isMcpTransport,
} from "./mcp.ts";

test("MCP_TRANSPORTS exposes the supported transports", () => {
  assert.deepEqual([...MCP_TRANSPORTS].sort(), ["http", "sse", "stdio"]);
});

test("MCP_SCOPES exposes global + per-agent", () => {
  assert.deepEqual([...MCP_SCOPES].sort(), ["global", "per-agent"]);
});

test("isMcpTransport accepts known transports", () => {
  assert.equal(isMcpTransport("stdio"), true);
  assert.equal(isMcpTransport("http"), true);
  assert.equal(isMcpTransport("sse"), true);
});

test("isMcpTransport rejects unknown strings", () => {
  assert.equal(isMcpTransport("websocket"), false);
  assert.equal(isMcpTransport(""), false);
  assert.equal(isMcpTransport(null), false);
});

test("isMcpServerConfig accepts a complete stdio config", () => {
  const cfg = {
    id: "mcp_test12345",
    name: "Filesystem MCP",
    description: "Local fs access",
    transport: "stdio",
    command: "/usr/local/bin/mcp-fs",
    args: ["--root", "/tmp"],
    env: { LOG_LEVEL: "info" },
    envSecretRefs: { API_TOKEN: "secret_mcp_fs_token" },
    scope: "global",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), true);
});

test("isMcpServerConfig accepts http config without command/args", () => {
  const cfg = {
    id: "mcp_http_1",
    name: "Remote MCP",
    description: "",
    transport: "http",
    url: "https://mcp.example.com/v1",
    env: {},
    envSecretRefs: {},
    scope: "global",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), true);
});

test("isMcpServerConfig rejects stdio without command", () => {
  const cfg = {
    id: "mcp_bad",
    name: "Bad",
    description: "",
    transport: "stdio",
    // command missing
    env: {},
    envSecretRefs: {},
    scope: "global",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), false);
});

test("isMcpServerConfig rejects http without url", () => {
  const cfg = {
    id: "mcp_bad",
    name: "Bad",
    description: "",
    transport: "http",
    // url missing
    env: {},
    envSecretRefs: {},
    scope: "global",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), false);
});

test("isMcpServerConfig rejects unknown transport", () => {
  const cfg = {
    id: "mcp_bad",
    name: "Bad",
    description: "",
    transport: "telepathy",
    env: {},
    envSecretRefs: {},
    scope: "global",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), false);
});

test("isMcpServerConfig rejects unknown scope", () => {
  const cfg = {
    id: "mcp_bad",
    name: "Bad",
    description: "",
    transport: "stdio",
    command: "/usr/bin/x",
    env: {},
    envSecretRefs: {},
    scope: "everywhere",
    enabled: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), false);
});

test("isMcpServerConfig accepts optional lastHealth", () => {
  const cfg = {
    id: "mcp_x",
    name: "X",
    description: "",
    transport: "stdio",
    command: "/usr/bin/x",
    env: {},
    envSecretRefs: {},
    scope: "global",
    enabled: true,
    lastHealth: {
      okAt: "2026-05-12T00:00:00.000Z",
      checkedAt: "2026-05-12T00:00:00.000Z",
    },
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isMcpServerConfig(cfg), true);
});
