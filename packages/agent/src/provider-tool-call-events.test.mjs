import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROVIDER_PENDING_CHARS,
  ProviderToolCallStreamParser,
  extractProviderToolCalls,
} from "./provider-tool-call-events.ts";

const codexOptions = {
  invocationId: "inv-codex-mcp",
  taskRunId: "task-codex-mcp",
  provider: "codex",
  source: "stdout",
};

test("extractProviderToolCalls names Codex MCP tool calls from server and tool fields", () => {
  const events = extractProviderToolCalls(
    JSON.stringify({
      type: "item.started",
      item: {
        id: "item_0",
        type: "mcp_tool_call",
        server: "harness_smoke",
        tool: "harness_smoke_echo",
        arguments: { message: "codex-mcp-smoke" },
        status: "in_progress",
      },
    }),
    codexOptions,
  );

  assert.deepEqual(events, [
    {
      type: "tool_call",
      invocationId: "inv-codex-mcp",
      taskRunId: "task-codex-mcp",
      provider: "codex",
      source: "stdout",
      phase: "started",
      toolName: "mcp__harness_smoke__harness_smoke_echo",
      toolCallId: "item_0",
      input: { message: "codex-mcp-smoke" },
    },
  ]);
});

test("extractProviderToolCalls preserves Codex MCP completed phase", () => {
  const events = extractProviderToolCalls(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "mcp_tool_call",
        server: "harness_smoke",
        tool: "harness_smoke_echo",
        arguments: { message: "codex-mcp-smoke" },
        status: "completed",
      },
    }),
    codexOptions,
  );

  assert.equal(events[0].phase, "completed");
  assert.equal(events[0].toolName, "mcp__harness_smoke__harness_smoke_echo");
});

test("ProviderToolCallStreamParser bounds an unterminated provider line", () => {
  const parser = new ProviderToolCallStreamParser(codexOptions);
  parser.feed("x".repeat(MAX_PROVIDER_PENDING_CHARS * 2));

  assert.ok(parser.pendingLength <= MAX_PROVIDER_PENDING_CHARS);
});

