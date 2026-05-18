import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyServerDraft,
  mcpGeneratedDraftToFormDraft,
  serializeServerDraft,
  serverDraftFromConfig,
  validateServerDraft,
} from "./mcp-server-form.ts";

const STDIO_CONFIG = {
  id: "mcp_test",
  name: "Filesystem MCP",
  description: "local fs",
  transport: "stdio",
  command: "/usr/local/bin/mcp-fs",
  args: ["--root", "/tmp"],
  env: { LOG_LEVEL: "info", FLAG: "" },
  envSecretRefs: { API_TOKEN: "fs_token_key" },
  scope: "global",
  enabled: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

test("emptyServerDraft starts as a valid stdio shell pending name+command", () => {
  const d = emptyServerDraft();
  d.name = "X";
  d.command = "/usr/bin/x";
  assert.deepEqual(validateServerDraft(d), []);
});

test("validateServerDraft rejects missing name", () => {
  const d = emptyServerDraft();
  d.command = "/usr/bin/x";
  const errors = validateServerDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validateServerDraft requires command on stdio transport", () => {
  const d = emptyServerDraft();
  d.name = "X";
  const errors = validateServerDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "command");
});

test("validateServerDraft requires http(s) URL on http transport", () => {
  const d = emptyServerDraft();
  d.name = "X";
  d.transport = "http";
  d.url = "ftp://wrong";
  const errors = validateServerDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "url");
});

test("validateServerDraft flags env line missing '=' (line numbered)", () => {
  const d = emptyServerDraft();
  d.name = "X";
  d.command = "/x";
  d.envText = "GOOD=value\nBROKEN\nALSO_GOOD=2";
  const errors = validateServerDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "envText");
  assert.match(errors[0].message, /라인 2/);
});

test("validateServerDraft allows empty value (FLAG=)", () => {
  const d = emptyServerDraft();
  d.name = "X";
  d.command = "/x";
  d.envText = "FLAG=";
  assert.deepEqual(validateServerDraft(d), []);
});

test("serverDraftFromConfig + serializeServerDraft is a round-trip", () => {
  const d = serverDraftFromConfig(STDIO_CONFIG);
  assert.equal(d.command, "/usr/local/bin/mcp-fs");
  assert.equal(d.argsText, "--root /tmp");
  // FLAG="" is allowed; serialization must preserve it.
  assert.match(d.envText, /FLAG=/);

  const out = serializeServerDraft(d);
  assert.equal(out.id, STDIO_CONFIG.id);
  assert.equal(out.command, STDIO_CONFIG.command);
  assert.deepEqual(out.args, STDIO_CONFIG.args);
  assert.equal(out.env.LOG_LEVEL, "info");
  assert.equal(out.env.FLAG, "");
  assert.equal(out.envSecretRefs.API_TOKEN, "fs_token_key");
  assert.equal(out.transport, "stdio");
  // http-only fields stay undefined for stdio.
  assert.equal(out.url, undefined);
});

test("serializeServerDraft strips command/args when switching to http", () => {
  // Users can flip transport in the editor without losing their work,
  // but the serialized payload only includes the relevant fields so
  // the SQL CHECK constraint doesn't see leftover stdio data.
  const d = emptyServerDraft();
  d.name = "Remote";
  d.transport = "http";
  d.url = "https://mcp.example.com";
  d.command = "leftover";
  d.argsText = "leftover";
  const out = serializeServerDraft(d);
  assert.equal(out.transport, "http");
  assert.equal(out.url, "https://mcp.example.com");
  assert.equal(out.command, undefined);
  assert.equal(out.args, undefined);
});

test("serializeServerDraft omits args field when text is whitespace-only", () => {
  const d = emptyServerDraft();
  d.name = "X";
  d.command = "/x";
  d.argsText = "   ";
  const out = serializeServerDraft(d);
  assert.equal(out.args, undefined);
});

test("mcpGeneratedDraftToFormDraft converts generated preview into a new unsaved draft", () => {
  const d = mcpGeneratedDraftToFormDraft({
    name: "GitHub MCP",
    description: "Generated MCP server draft for GitHub.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {},
    envSecretRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: "github_token" },
    scope: "global",
    enabled: false,
    recommendedProfileIds: [],
    secretPlaceholders: ["github_token"],
    rationale: "preview only",
  });

  assert.equal(d.id, null);
  assert.equal(d.name, "GitHub MCP");
  assert.equal(d.command, "npx");
  assert.equal(d.argsText, "-y @modelcontextprotocol/server-github");
  assert.equal(d.envSecretRefsText, "GITHUB_PERSONAL_ACCESS_TOKEN=github_token");
  assert.equal(d.enabled, false);
});
