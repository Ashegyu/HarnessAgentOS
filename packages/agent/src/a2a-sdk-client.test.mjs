import { test } from "node:test";
import assert from "node:assert/strict";
import { OfficialA2AClientPort } from "./a2a-sdk-client.ts";

const request = {
  invocationId: "inv_sdk_1",
  taskRunId: "task_run_1",
  endpointId: "endpoint_1",
  message: "Review this change.",
};

const endpoint = {
  id: "endpoint_1",
  name: "Remote Reviewer",
  baseUrl: "https://agents.example.com",
  agentCardUrl: "https://agents.example.com/custom/agent-card.json",
  preferredTransport: "json-rpc",
  enabled: true,
  trusted: true,
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

test("OfficialA2AClientPort creates an SDK client from endpoint URL and maps stream events", async () => {
  const factoryCalls = [];
  const sendCalls = [];
  const client = {
    sendMessageStream(params, options) {
      sendCalls.push({ params, options });
      return (async function* () {
        yield {
          kind: "task",
          id: "remote-task-1",
          contextId: "remote-context-1",
          status: { state: "submitted" },
        };
        yield {
          kind: "status-update",
          taskId: "remote-task-1",
          contextId: "remote-context-1",
          status: {
            state: "working",
            message: {
              kind: "message",
              messageId: "msg-status",
              role: "agent",
              parts: [{ kind: "text", text: "Working with SECRET_TOKEN" }],
            },
          },
        };
        yield {
          kind: "artifact-update",
          taskId: "remote-task-1",
          contextId: "remote-context-1",
          artifact: {
            artifactId: "artifact-1",
            name: "analysis.json",
            parts: [{ kind: "data", data: { ok: true } }],
          },
        };
        yield {
          kind: "message",
          messageId: "msg-final",
          role: "agent",
          parts: [{ kind: "text", text: "Done with SECRET_TOKEN" }],
        };
        yield {
          kind: "status-update",
          taskId: "remote-task-1",
          contextId: "remote-context-1",
          status: { state: "completed" },
          final: true,
        };
      })();
    },
  };
  const port = new OfficialA2AClientPort({
    endpoint,
    createClientFactory: (options) => {
      factoryCalls.push(options);
      return {
        createFromUrl: async (baseUrl, path) => {
          factoryCalls.push({ baseUrl, path });
          return client;
        },
      };
    },
    createMessageId: () => "message-1",
    redactText: (text) => text.replace(/SECRET_TOKEN/g, "[redacted]"),
  });

  const events = await collect(await port.invoke(request));

  assert.deepEqual(factoryCalls[0], { preferredTransports: ["JSONRPC"] });
  assert.deepEqual(factoryCalls[1], {
    baseUrl: "https://agents.example.com",
    path: "/custom/agent-card.json",
  });
  assert.deepEqual(sendCalls[0].params, {
    message: {
      kind: "message",
      messageId: "message-1",
      role: "user",
      parts: [{ kind: "text", text: "Review this change." }],
    },
  });
  assert.equal(sendCalls[0].options.signal instanceof AbortSignal, true);
  assert.deepEqual(events, [
    {
      type: "task-state",
      state: "submitted",
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
    },
    {
      type: "task-state",
      state: "working",
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
      message: "Working with [redacted]",
    },
    {
      type: "message",
      text: "Working with [redacted]",
    },
    {
      type: "artifact",
      artifact: {
        id: "artifact-1",
        title: "analysis.json",
        mimeType: "application/json",
        data: { ok: true },
      },
    },
    {
      type: "message",
      text: "Done with [redacted]",
    },
    {
      type: "task-state",
      state: "completed",
      remoteTaskId: "remote-task-1",
      remoteContextId: "remote-context-1",
    },
  ]);
});

test("OfficialA2AClientPort maps http-json transport preference", async () => {
  const factoryCalls = [];
  const port = new OfficialA2AClientPort({
    endpoint: { ...endpoint, preferredTransport: "http-json" },
    createClientFactory: (options) => {
      factoryCalls.push(options);
      return {
        createFromUrl: async () => ({
          sendMessageStream: () => (async function* () {})(),
        }),
      };
    },
  });

  await collect(await port.invoke(request));

  assert.deepEqual(factoryCalls[0], { preferredTransports: ["HTTP+JSON"] });
});

test("OfficialA2AClientPort propagates caller cancellation into SDK request options", async () => {
  let capturedSignal;
  const controller = new AbortController();
  const port = new OfficialA2AClientPort({
    endpoint,
    createClientFactory: () => ({
      createFromUrl: async () => ({
        sendMessageStream: (_params, options) => {
          capturedSignal = options.signal;
          return (async function* () {
            while (!capturedSignal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          })();
        },
      }),
    }),
  });

  const iterator = (await port.invoke(request, controller.signal))[Symbol.asyncIterator]();
  const pending = iterator.next().catch((error) => error);
  while (!capturedSignal) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  const error = await pending;

  assert.equal(capturedSignal.aborted, true);
  assert.equal(error.name, "AbortError");
});
