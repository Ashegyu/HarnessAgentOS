import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpProbe } from "./mcp-probe.ts";

const FIXED_NOW = new Date("2026-05-17T00:00:00.000Z");

const stdioServer = (args) => ({
  id: "mcp_test",
  name: "Test MCP",
  description: "",
  transport: "stdio",
  command: process.execPath,
  args,
  env: {},
  envSecretRefs: {},
  scope: "global",
  enabled: true,
  createdAt: FIXED_NOW.toISOString(),
  updatedAt: FIXED_NOW.toISOString(),
});

const httpServer = (url = "https://mcp.example.test/sse") => ({
  id: "mcp_http",
  name: "HTTP MCP",
  description: "",
  transport: "sse",
  url,
  env: {},
  envSecretRefs: {},
  scope: "global",
  enabled: true,
  createdAt: FIXED_NOW.toISOString(),
  updatedAt: FIXED_NOW.toISOString(),
});

test("mcp probe accepts Content-Length framed stdio initialize responses", async () => {
  const script = [
    "process.stdin.once('data', () => {",
    "const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });",
    "process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\\r\\n\\r\\n${body}`);",
    "});",
  ].join("");
  const health = await createMcpProbe({ now: () => FIXED_NOW })(
    stdioServer(["-e", script]),
  );
  assert.equal(health.okAt, FIXED_NOW.toISOString());
  assert.equal(health.error, undefined);
});

test("mcp probe keeps newline JSON stdout compatibility", async () => {
  const script = [
    "process.stdin.once('data', () => {",
    "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');",
    "});",
  ].join("");
  const health = await createMcpProbe({ now: () => FIXED_NOW })(
    stdioServer(["-e", script]),
  );
  assert.equal(health.okAt, FIXED_NOW.toISOString());
  assert.equal(health.error, undefined);
});

test("mcp probe includes stderr tail when a stdio server exits", async () => {
  const script = [
    "process.stdin.once('data', () => {",
    "process.stderr.write('missing token\\n');",
    "process.exit(3);",
    "});",
  ].join("");
  const health = await createMcpProbe({ now: () => FIXED_NOW })(
    stdioServer(["-e", script]),
  );
  assert.equal(health.okAt, undefined);
  assert.match(health.error, /exit 3/);
  assert.match(health.error, /missing token/);
});

test("mcp probe falls back to GET when HTTP HEAD fails", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init?.method);
    if (init?.method === "HEAD") throw new Error("HEAD refused");
    return new Response("", { status: 200 });
  };
  const health = await createMcpProbe({
    now: () => FIXED_NOW,
    fetchImpl,
  })(httpServer());
  assert.equal(health.okAt, FIXED_NOW.toISOString());
  assert.deepEqual(calls, ["HEAD", "GET"]);
});
