import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_SMOKE_MARKER,
  SMOKE_MCP_SERVER_SOURCE,
  buildCodexMcpSmokeRequest,
  isCodexMcpSmokeToolCall,
  summarizeCodexMcpSmokeOutcome,
} from "./smoke-agent-codex-mcp.mjs";

test("buildCodexMcpSmokeRequest injects stdio/no-secret MCP overrides", () => {
  const request = buildCodexMcpSmokeRequest({
    cwd: "C:\\tmp\\hgos-codex-mcp",
    invocationId: "inv-codex-mcp",
    serverPath: "C:\\tmp\\hgos-codex-mcp\\server.mjs",
    timeoutMs: 120_000,
  });

  assert.equal(request.invocationId, "inv-codex-mcp");
  assert.equal(request.cwd, "C:\\tmp\\hgos-codex-mcp");
  assert.equal(request.modelConfig.provider, "codex");
  assert.equal(request.modelConfig.model, "gpt-5.6-sol");
  assert.match(request.prompt, /harness_smoke_echo/);
  assert.match(request.prompt, /HARNESS_MCP_SMOKE_OK/);
  assert.deepEqual(request.codexConfigOverrides, [
    `mcp_servers.harness_smoke.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.harness_smoke.args=["C:\\\\tmp\\\\hgos-codex-mcp\\\\server.mjs"]`,
  ]);
  assert.equal(request.mcpConfigPath, undefined);
});

test("isCodexMcpSmokeToolCall recognizes namespaced MCP tool calls", () => {
  assert.equal(
    isCodexMcpSmokeToolCall({
      type: "tool_call",
      provider: "codex",
      phase: "started",
      toolName: "mcp__harness_smoke__harness_smoke_echo",
    }),
    true,
  );
  assert.equal(
    isCodexMcpSmokeToolCall({
      type: "tool_call",
      provider: "codex",
      phase: "started",
      toolName: "mcp_tool_call",
    }),
    true,
  );
  assert.equal(
    isCodexMcpSmokeToolCall({
      type: "tool_call",
      provider: "codex",
      phase: "started",
      toolName: "shell_command",
    }),
    false,
  );
});

test("summarizeCodexMcpSmokeOutcome requires a smoke tool call and marker", () => {
  const toolCall = {
    type: "tool_call",
    provider: "codex",
    phase: "started",
    toolName: "mcp__harness_smoke__harness_smoke_echo",
  };

  assert.deepEqual(
    summarizeCodexMcpSmokeOutcome({
      toolCalls: [toolCall],
      rawOutput: `tool said ${MCP_SMOKE_MARKER}`,
    }),
    {
      ok: true,
      reason: "Codex emitted the Harness MCP smoke tool_call and returned the marker.",
    },
  );
  assert.equal(
    summarizeCodexMcpSmokeOutcome({
      toolCalls: [],
      rawOutput: `tool said ${MCP_SMOKE_MARKER}`,
    }).ok,
    false,
  );
  assert.equal(
    summarizeCodexMcpSmokeOutcome({
      toolCalls: [toolCall],
      rawOutput: "no marker",
    }).ok,
    false,
  );
});

test("smoke MCP server responds to newline initialize requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-codex-mcp-server-test-"));
  const serverPath = join(dir, "server.mjs");
  writeFileSync(serverPath, SMOKE_MCP_SERVER_SOURCE, "utf8");
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  const responsePromise = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for initialize: ${output}`)),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const lineEnd = output.indexOf("\n");
      if (lineEnd < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.slice(0, lineEnd)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before initialize response: ${code}`));
    });
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness-test", version: "0.0.0" },
      },
    }) + "\n",
  );
  const response = await responsePromise;

  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "harness-codex-mcp-smoke");
});
