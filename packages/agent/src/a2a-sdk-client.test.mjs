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

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const within = async promise => {
  let timer;
  try { return await Promise.race([promise.then(value => ({ value }), error => ({ error })), new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 250); })]); }
  finally { clearTimeout(timer); }
};

const agentCard = { name: "Fixture", url: "https://agents.example.com/rpc", version: "1", protocolVersion: "0.3.0",
  capabilities: { streaming: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] };
const sse = result => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;

test("the installed SDK uses bounded fetch for both agent-card discovery and streaming", async () => {
  const calls = [];
  const port = new OfficialA2AClientPort({ endpoint, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), signal: init.signal });
    return calls.length === 1 ? Response.json(agentCard) : new Response([
      sse({ kind: "message", parts: [{ kind: "text", text: "실제 SDK 응답" }] }),
      sse({ kind: "status-update", taskId: "remote", status: { state: "completed" }, final: true }),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const events = await collect(port.invoke(request));
  assert.equal(events.find(event => event.type === "message").text, "실제 SDK 응답");
  assert.equal(events.at(-1).state, "completed"); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && call.signal.aborted));
});

for (const phase of ["agent card", "SSE without a frame delimiter", "advertised body length"]) {
  test(`the installed SDK rejects excess ${phase} before unbounded parsing`, async () => {
    let calls = 0, cancelled = 0;
    const port = new OfficialA2AClientPort({ endpoint, limits: { maxAgentCardBytes: 400, maxResponseBytes: 800 },
      fetchImpl: async () => {
        calls++;
        if (calls === 1 && phase !== "agent card") return Response.json(agentCard);
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1000))); },
          cancel() { cancelled++; } }), { headers: phase === "advertised body length"
            ? { "content-length": "999999", "content-type": "text/event-stream" } : { "content-type": "text/event-stream" } });
      } });
    await assert.rejects(collect(port.invoke(request)), error => error.code === "A2A_RESPONSE_LIMIT");
    assert.equal(calls, phase === "agent card" ? 1 : 2); assert.equal(cancelled, 1);
  });
}

test("a stalled agent-card body is covered by the discovery deadline", async () => {
  let cancelled = 0;
  const port = new OfficialA2AClientPort({ endpoint, timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled++; },
  })) });
  const outcome = await within(collect(port.invoke(request)));
  assert.equal(outcome.error?.code, "A2A_REQUEST_TIMEOUT"); assert.equal(cancelled, 1);
});

test("the installed HTTP+JSON transport uses the same wire budget and abort scope", async () => {
  let calls = 0;
  const port = new OfficialA2AClientPort({ endpoint: { ...endpoint, preferredTransport: "http-json" }, fetchImpl: async () => {
    calls++;
    return calls === 1 ? Response.json({ ...agentCard, preferredTransport: "HTTP+JSON" }) :
      new Response(`data: ${JSON.stringify({ message: { messageId: "rest", role: "ROLE_AGENT", content: [{ text: "REST fixture" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  assert.deepEqual(await collect(port.invoke(request)), [{ type: "message", text: "REST fixture" }]);
  assert.equal(calls, 2);
});

test("a nonstreaming SDK fallback is bounded and retains its actual message", async () => {
  let calls = 0;
  const port = new OfficialA2AClientPort({ endpoint, fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json({ ...agentCard, capabilities: { streaming: false } });
    assert.equal(JSON.parse(init.body).method, "message/send");
    return Response.json({ jsonrpc: "2.0", id: 1, result: { kind: "message", parts: [{ kind: "text", text: "fallback fixture" }] } });
  } });
  assert.deepEqual(await collect(port.invoke(request)), [{ type: "message", text: "fallback fixture" }]);
});

test("breaking SDK consumption closes the source and aborts its owned signal", async () => {
  let signal, returned = 0;
  const port = new OfficialA2AClientPort({ endpoint, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessageStream: (_params, options) => { signal = options.signal; return (async function* () {
      try { yield { kind: "message", parts: [{ kind: "text", text: "first" }] }; yield { kind: "message", parts: [{ kind: "text", text: "second" }] }; }
      finally { returned++; }
    })(); },
  }) }) });
  for await (const _event of port.invoke(request)) break;
  assert.equal(returned, 1); assert.equal(signal.aborted, true);
});

test("cancellation between mapped events discards the remainder of the same SDK packet", async () => {
  const controller = new AbortController();
  const port = new OfficialA2AClientPort({ endpoint, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessageStream: () => (async function* () { yield { kind: "status-update", taskId: "remote",
      status: { state: "working", message: { parts: [{ kind: "text", text: "must not arrive late" }] } } }; })(),
  }) }) });
  const iterator = port.invoke(request, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "task-state");
  controller.abort();
  await assert.rejects(iterator.next(), error => error.name === "AbortError");
});

test("an under-budget SDK response is not silently truncated or rewritten before execution parsing", async () => {
  const text = "x".repeat(220_000) + '{"api_key":"SYNTHETIC_A2A_RESPONSE"}';
  let calls = 0;
  const port = new OfficialA2AClientPort({ endpoint, fetchImpl: async () => ++calls === 1 ? Response.json(agentCard) :
    new Response(sse({ kind: "message", parts: [{ kind: "text", text }] }), { headers: { "content-type": "text/event-stream" } }) });
  const events = await collect(port.invoke(request));
  assert.equal(events[0].text.length, text.length);
  assert.equal(events[0].text, text);
});

test("a send-only SDK client is bounded even when sendMessage ignores cancellation", async () => {
  const port = new OfficialA2AClientPort({ endpoint, timeoutMs: 10, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessage: () => new Promise(() => {}),
  }) }) });
  const outcome = await within(collect(port.invoke(request)));
  assert.equal(outcome.error?.code, "A2A_REQUEST_TIMEOUT");
});

test("a completed task carrying too many artifacts cannot turn a partial response into success", async () => {
  const port = new OfficialA2AClientPort({ endpoint, limits: { maxArtifacts: 1 }, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessageStream: () => (async function* () { yield { kind: "task", id: "oversized-task", status: { state: "completed" },
      artifacts: ["a", "b"].map(artifactId => ({ artifactId, parts: [{ kind: "data", data: { value: "fixture" } }] })) }; })(),
  }) }) });
  const { A2AInvocationAdapter } = await import("./a2a-invocation-adapter.ts");
  const events = [];
  await assert.rejects(new A2AInvocationAdapter({ client: port }).invoke(request, event => events.push(event)), error => error.code === "A2A_RESPONSE_LIMIT");
  assert.equal(events.some(event => event.type === "result"), false);
});

test("an already cancelled invocation does not begin discovery", async () => {
  let discoveries = 0;
  const controller = new AbortController(); controller.abort();
  const port = new OfficialA2AClientPort({ endpoint, createClientFactory: () => ({ createFromUrl: async () => {
    discoveries++; return { sendMessageStream: () => (async function* () {})() };
  } }) });
  await assert.rejects(collect(port.invoke(request, controller.signal)), error => error.name === "AbortError");
  assert.equal(discoveries, 0);
});

for (const stop of ["deadline", "caller cancellation"]) {
  test(`discovery is bounded by ${stop} and late discovery cannot send`, async () => {
    const discovery = deferred(), entered = deferred();
    let sent = 0, discoverySignal;
    const controller = new AbortController();
    const client = { sendMessageStream: () => { sent++; return (async function* () {})(); } };
    const port = new OfficialA2AClientPort({ endpoint, timeoutMs: stop === "deadline" ? 15 : 5000,
      createClientFactory: options => { discoverySignal = options.signal; return { createFromUrl: () => { entered.resolve(); return discovery.promise; } }; } });
    const pending = collect(port.invoke(request, controller.signal));
    await entered.promise;
    if (stop !== "deadline") controller.abort();
    const outcome = await within(pending);
    discovery.resolve(client);
    await pending.catch(() => {});
    assert.equal(outcome.stalled, undefined);
    assert.equal(stop === "deadline" ? outcome.error?.code : outcome.error?.name, stop === "deadline" ? "A2A_REQUEST_TIMEOUT" : "AbortError");
    assert.equal(discoverySignal?.aborted, true);
    assert.equal(sent, 0);
  });
}

test("cancellation bounds an SDK iterator that ignores its signal and return", async () => {
  const entered = deferred(); let closed = 0;
  const controller = new AbortController();
  const port = new OfficialA2AClientPort({ endpoint, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessageStream: () => ({ [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return new Promise(() => {}); },
      return() { closed++; return new Promise(() => {}); } }),
  }) }) });
  const pending = collect(port.invoke(request, controller.signal)); await entered.promise; controller.abort();
  const outcome = await within(pending);
  assert.equal(outcome.error?.name, "AbortError"); assert.equal(closed, 1);
});

test("unknown SDK events count toward the response event limit", async () => {
  let closed = false;
  const port = new OfficialA2AClientPort({ endpoint, limits: { maxEvents: 2 }, createClientFactory: () => ({ createFromUrl: async () => ({
    sendMessageStream: () => (async function* () { try { for (let i = 0; i < 10; i++) yield { kind: "unknown", padding: "x" }; } finally { closed = true; } })(),
  }) }) });
  await assert.rejects(collect(port.invoke(request)), error => error.code === "A2A_RESPONSE_LIMIT"); assert.equal(closed, true);
});

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

  assert.deepEqual(factoryCalls[0].preferredTransports, ["JSONRPC"]);
  assert.equal(factoryCalls[0].signal instanceof AbortSignal, true);
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

  assert.deepEqual(factoryCalls[0].preferredTransports, ["HTTP+JSON"]);
});

test("OfficialA2AClientPort maps context, task, references, and metadata into SDK message", async () => {
  const sendCalls = [];
  const port = new OfficialA2AClientPort({
    endpoint,
    createClientFactory: () => ({
      createFromUrl: async () => ({
        sendMessageStream: (params) => {
          sendCalls.push(params);
          return (async function* () {})();
        },
      }),
    }),
    createMessageId: () => "message-refinement",
  });

  await collect(
    await port.invoke({
      ...request,
      contextId: "remote-context-1",
      taskId: "remote-task-1",
      referenceTaskIds: ["remote-task-0"],
      metadata: {
        harness: {
          refinementAttemptId: "a2aRefinement_1",
          artifactIds: ["art-review"],
        },
      },
    }),
  );

  assert.deepEqual(sendCalls[0], {
    message: {
      kind: "message",
      messageId: "message-refinement",
      role: "user",
      contextId: "remote-context-1",
      taskId: "remote-task-1",
      referenceTaskIds: ["remote-task-0"],
      metadata: {
        harness: {
          refinementAttemptId: "a2aRefinement_1",
          artifactIds: ["art-review"],
        },
      },
      parts: [{ kind: "text", text: "Review this change." }],
    },
  });
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
