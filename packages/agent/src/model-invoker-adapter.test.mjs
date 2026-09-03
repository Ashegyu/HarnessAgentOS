import { test } from "node:test";
import assert from "node:assert/strict";
import { modelInvokerFromCliAdapter } from "./model-invoker-adapter.ts";

const request = {
  invocationId: "inv-wrapper",
  taskRunId: "tr-wrapper",
  cwd: "/tmp/project",
  prompt: "user prompt",
  systemPrompt: "system prompt",
  modelConfig: {
    provider: "codex",
    model: "gpt-5.6-sol",
    timeoutMs: 30_000,
    stallTimeoutMs: 5_000,
  },
  sandbox: {
    primaryDir: "/tmp/project",
    enforceInPrompt: true,
  },
  codexConfigOverrides: ["mcp_servers.repo.command=node"],
  toolPolicy: {
    toolAllowlist: ["Read"],
    toolDenylist: ["Bash"],
  },
};

test("modelInvokerFromCliAdapter preserves request, signal, events, and result", async () => {
  const signal = new AbortController().signal;
  const event = {
    type: "started",
    invocationId: request.invocationId,
    taskRunId: request.taskRunId,
    provider: "codex",
    model: "gpt-5.6-sol",
  };
  const result = {
    provider: "codex",
    model: "gpt-5.6-sol",
    exitCode: 0,
    stdout: "assistant output",
    rawStdout: "raw assistant output",
    stderr: "stderr output",
    normalizedEvents: [event],
    latencyMs: 42,
    costEstimate: 0.12,
  };
  let seenRequest = null;
  let seenSignal = null;
  const adapter = {
    async invoke(nextRequest, onEvent, nextSignal) {
      seenRequest = nextRequest;
      seenSignal = nextSignal;
      onEvent(event);
      return result;
    },
  };
  const emitted = [];
  const invoker = modelInvokerFromCliAdapter(adapter);
  const actual = await invoker.invoke(request, (nextEvent) => {
    emitted.push(nextEvent);
  }, signal);

  assert.equal(seenRequest, request);
  assert.equal(seenSignal, signal);
  assert.deepEqual(emitted, [event]);
  assert.equal(actual, result);
});
