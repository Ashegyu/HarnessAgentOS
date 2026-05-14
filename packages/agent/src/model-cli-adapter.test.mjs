import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCliInvocation,
  extractCodexExecPayload,
  formatProviderExitFailure,
} from "./model-cli-invocation.ts";

const baseRequest = (overrides = {}) => ({
  invocationId: "inv-1",
  taskRunId: "tsk-1",
  cwd: "C:\\repo",
  prompt: "USER REQUEST",
  modelConfig: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
  },
  sandbox: { primaryDir: "C:\\repo", enforceInPrompt: true },
  ...overrides,
});

test("buildCliInvocation keeps Claude-specific flags on the Claude command", () => {
  const plan = buildCliInvocation(
    baseRequest({
      sessionId: "claude-session",
      systemPrompt: "SYSTEM PROMPT",
      mcpConfigPath: "C:\\tmp\\mcp.json",
    }),
  );

  assert.equal(plan.command, "claude");
  assert.equal(plan.stdin, "USER REQUEST");
  assert.deepEqual(plan.args, [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    "claude-sonnet-4-6",
    "--system-prompt",
    "SYSTEM PROMPT",
    "--resume",
    "claude-session",
    "--mcp-config",
    "C:\\tmp\\mcp.json",
  ]);
});

test("buildCliInvocation uses Codex exec syntax and folds system prompt into stdin", () => {
  const plan = buildCliInvocation(
    baseRequest({
      modelConfig: {
        provider: "codex",
        model: "gpt-5.5",
        timeoutMs: 300_000,
        stallTimeoutMs: 60_000,
      },
      systemPrompt: "SYSTEM PROMPT",
      sessionId: "ignored-for-codex",
      mcpConfigPath: "C:\\tmp\\mcp.json",
    }),
  );

  assert.equal(plan.command, "codex");
  assert.deepEqual(plan.args, [
    "--model",
    "gpt-5.5",
    "--cd",
    "C:\\repo",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);
  assert.match(plan.stdin, /SYSTEM INSTRUCTIONS/);
  assert.match(plan.stdin, /SYSTEM PROMPT/);
  assert.match(plan.stdin, /USER REQUEST/);
  assert.ok(!plan.args.includes("--system-prompt"));
  assert.ok(!plan.args.includes("--resume"));
  assert.ok(!plan.args.includes("--mcp-config"));
});

test("extractCodexExecPayload returns the final assistant message from JSONL", () => {
  const raw = [
    JSON.stringify({ type: "session_configured", session_id: "s1" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "assistant_message",
        role: "assistant",
        content: [{ type: "output_text", text: "first" }],
      },
    }),
    JSON.stringify({
      type: "item_completed",
      item: {
        id: "msg-2",
        type: "assistant_message",
        role: "assistant",
        text: "final",
      },
    }),
  ].join("\n");

  assert.equal(extractCodexExecPayload(raw), "final");
});

test("formatProviderExitFailure reads Codex JSON errors from stdout", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thr" }),
    JSON.stringify({
      type: "error",
      message:
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    }),
    JSON.stringify({
      type: "turn.failed",
      error: {
        message:
          "stream disconnected before completion: error sending request for url",
      },
    }),
  ].join("\n");

  const message = formatProviderExitFailure("codex", 1, stdout, "");
  assert.match(message, /codex exited with code 1/);
  assert.match(message, /authentication failed/);
  assert.match(message, /401 Unauthorized/);
});

test("formatProviderExitFailure falls back to stderr for non-Codex failures", () => {
  assert.equal(
    formatProviderExitFailure("claude", 1, "", "auth failed\n"),
    "claude exited with code 1: auth failed",
  );
});
