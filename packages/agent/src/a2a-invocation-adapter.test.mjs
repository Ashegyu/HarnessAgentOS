import { test } from "node:test";
import assert from "node:assert/strict";
import {
  A2AInvocationAdapter,
  A2AInvocationError,
  a2aInvocationToWorkerOutcome,
  parseA2AInvocationPlan,
} from "./a2a-invocation-adapter.ts";

const request = {
  invocationId: "inv_a2a_1",
  taskRunId: "task_run_1",
  endpointId: "endpoint_1",
  message: "Analyze the current project.",
};

const makeClock = () => {
  let tick = 0;
  return () => `2026-05-15T00:00:0${tick++}.000Z`;
};

const makeClient = (events, calls = []) => ({
  async *invoke(input, signal) {
    calls.push({ input, signal });
    for (const event of events) {
      yield event;
    }
  },
});

for (const [name, limits, events] of [
  ["events", { maxEvents: 2 }, Array.from({ length: 3 }, () => ({ type: "usage", latencyMs: 1 }))],
  ["UTF-8 text including separators", { maxTextBytes: 7 }, [{ type: "message", text: "한" }, { type: "message", text: "글" }]],
  ["artifacts", { maxArtifacts: 1 }, [{ type: "artifact", artifact: { text: "one" } }, { type: "artifact", artifact: { text: "two" } }]],
  ["one large event", { maxEventBytes: 80 }, [{ type: "message", text: "한".repeat(80) }]],
  ["aggregate response bytes", { maxResponseBytes: 120 }, Array.from({ length: 4 }, () => ({ type: "message", text: "x".repeat(30) }))],
  ["artifact data", { maxArtifactBytes: 100 }, [{ type: "artifact", artifact: { data: { value: "x".repeat(100) } } }]],
  ["total artifact data", { maxTotalArtifactBytes: 60 }, Array.from({ length: 3 }, () => ({ type: "artifact", artifact: { text: "x".repeat(20) } }))],
]) {
  test(`A2A adapter rejects excess ${name} without producing a success result`, async () => {
    const emitted = []; let closed = false, capturedSignal;
    const adapter = new A2AInvocationAdapter({ limits, client: { async *invoke(_input, signal) {
      capturedSignal = signal;
      try { yield* events; yield { type: "task-state", state: "completed" }; } finally { closed = true; }
    } } });
    await assert.rejects(adapter.invoke(request, event => emitted.push(event)), error => error.code === "A2A_RESPONSE_LIMIT");
    assert.equal(emitted.some(e => e.type === "result"), false);
    assert.equal(emitted.at(-1).errorCode, "A2A_RESPONSE_LIMIT");
    assert.equal(capturedSignal.aborted, true); assert.equal(closed, true);
  });
}

test("the adapter retains a bounded diagnostic tail while preserving bounded complete output", async () => {
  const emitted = [];
  const adapter = new A2AInvocationAdapter({ limits: { maxRetainedEvents: 3, maxRetainedEventBytes: 1000 },
    client: makeClient([...Array.from({ length: 8 }, (_, i) => ({ type: "message", text: String(i) })), { type: "task-state", state: "completed" }]) });
  const result = await adapter.invoke(request, event => emitted.push(event));
  assert.equal(result.outputText, "0\n\n1\n\n2\n\n3\n\n4\n\n5\n\n6\n\n7");
  assert.equal(result.normalizedEvents.length, 3);
  assert.equal(result.normalizedEvents.at(-1).type, "result");
  assert.equal(result.droppedNormalizedEvents, emitted.length - 3);
});

test("adapter cancellation bounds an uncooperative client and closes it without waiting for return", async () => {
  let entered, returned = 0, capturedSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const adapter = new A2AInvocationAdapter({ client: { invoke(_request, signal) { capturedSignal = signal; return {
    [Symbol.asyncIterator]() { return this; }, next() { entered(); return new Promise(() => {}); },
    return() { returned++; return new Promise(() => {}); },
  }; } } });
  const emitted = [], pending = adapter.invoke(request, e => emitted.push(e), controller.signal);
  await started; controller.abort(new Error("user stop"));
  await assert.rejects(pending, e => e.name === "AbortError");
  assert.equal(capturedSignal.aborted, true); assert.equal(returned, 1); assert.equal(emitted.at(-1).type, "cancelled");
});

test("adapter deadline bounds asynchronous invoke preparation and emits one failure", async () => {
  const events = [];
  const adapter = new A2AInvocationAdapter({ timeoutMs: 10, client: { invoke: () => new Promise(() => {}) } });
  await assert.rejects(adapter.invoke(request, e => events.push(e)), error => error.code === "A2A_REQUEST_TIMEOUT");
  assert.deepEqual(events.map(e => e.type), ["failed"]);
});

test("a stream returned after cancellation is closed instead of becoming an orphan", async () => {
  let deliver, returned = 0;
  const controller = new AbortController();
  const late = new Promise(resolve => { deliver = resolve; });
  const adapter = new A2AInvocationAdapter({ client: { invoke: () => late } });
  const pending = adapter.invoke(request, () => {}, controller.signal);
  controller.abort(); await assert.rejects(pending, error => error.name === "AbortError");
  deliver({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return() { returned++; return Promise.resolve({ done: true }); } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, 1);
});

test("UTF-8 and artifact budgets accept an exact boundary, and retained event bytes stay bounded", async () => {
  const adapter = new A2AInvocationAdapter({ limits: { maxTextBytes: 8, maxRetainedEventBytes: 190, maxArtifacts: 1 },
    client: makeClient([{ type: "message", text: "한" }, { type: "message", text: "글" },
      { type: "artifact", artifact: { data: { ok: true } } }, { type: "task-state", state: "completed" }]) });
  const result = await adapter.invoke(request, () => {});
  assert.equal(Buffer.byteLength(result.outputText), 8); assert.equal(result.artifacts.length, 1);
  assert.ok(result.normalizedEvents.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0) <= 190);
});

test("default event caps stop a progress flood and never emit a successful result", async () => {
  let produced = 0, closed = false, emitted = 0;
  const adapter = new A2AInvocationAdapter({ client: { async *invoke() {
    try { for (let i = 0; i < 10_000; i++) { produced++; yield { type: "task-state", state: "working" }; } }
    finally { closed = true; }
  } } });
  await assert.rejects(adapter.invoke(request, event => { emitted++; assert.notEqual(event.type, "result"); }), error => error.code === "A2A_RESPONSE_LIMIT");
  assert.equal(produced, 4097); assert.equal(emitted, 4097); assert.equal(closed, true);
});

test("A2AInvocationAdapter maps remote state, text, and artifacts into agent stream events", async () => {
  const calls = [];
  const emitted = [];
  const adapter = new A2AInvocationAdapter({
    client: makeClient(
      [
        {
          type: "task-state",
          state: "submitted",
          remoteTaskId: "remote_task_1",
          remoteContextId: "remote_context_1",
          message: "remote task submitted",
        },
        { type: "task-state", state: "working", message: "remote agent working" },
        {
          type: "artifact",
          artifact: {
            id: "remote_artifact_1",
            title: "analysis.json",
            mimeType: "application/json",
            data: { verdict: "ok" },
          },
        },
        { type: "message", text: "Remote analysis complete." },
        { type: "task-state", state: "completed", message: "remote task completed" },
      ],
      calls,
    ),
    now: makeClock(),
  });

  const result = await adapter.invoke(request, (event) => emitted.push(event));

  assert.deepEqual(calls[0].input, request);
  assert.equal(result.outputText, "Remote analysis complete.");
  assert.equal(result.remoteTask.endpointId, "endpoint_1");
  assert.equal(result.remoteTask.remoteTaskId, "remote_task_1");
  assert.equal(result.remoteTask.remoteContextId, "remote_context_1");
  assert.equal(result.remoteTask.state, "completed");
  assert.deepEqual(result.artifacts, [
    {
      remoteArtifactId: "remote_artifact_1",
      title: "analysis.json",
      contentType: "application/json",
      text: undefined,
      data: { verdict: "ok" },
      url: undefined,
    },
  ]);

  assert.deepEqual(
    emitted.map((event) => event.type),
    ["progress", "progress", "assistant_text", "progress", "result"],
  );
  assert.deepEqual(
    emitted
      .filter((event) => event.type === "progress")
      .map((event) => [event.stage, event.message]),
    [
      ["queued", "remote task submitted"],
      ["cli", "remote agent working"],
      ["complete", "remote task completed"],
    ],
  );
  assert.deepEqual(result.normalizedEvents, emitted);
});

test("A2AInvocationAdapter returns input-required without completing the invocation", async () => {
  const emitted = [];
  const adapter = new A2AInvocationAdapter({
    client: makeClient([
      {
        type: "task-state",
        state: "input-required",
        remoteTaskId: "remote_task_2",
        message: "remote agent needs clarification",
      },
    ]),
    now: makeClock(),
  });

  const result = await adapter.invoke(request, (event) => emitted.push(event));

  assert.equal(result.requiresInput, true);
  assert.equal(result.remoteTask.state, "input-required");
  assert.equal(result.outputText, "");
  assert.deepEqual(
    emitted.map((event) => event.type),
    ["progress"],
  );
  assert.equal(emitted[0].stage, "cli");
});

test("A2AInvocationAdapter emits failed and rejects failed remote tasks", async () => {
  const emitted = [];
  const adapter = new A2AInvocationAdapter({
    client: makeClient([
      {
        type: "task-state",
        state: "rejected",
        remoteTaskId: "remote_task_3",
        message: "remote policy rejected the request",
      },
    ]),
    now: makeClock(),
  });

  await assert.rejects(
    () => adapter.invoke(request, (event) => emitted.push(event)),
    (error) => {
      assert.ok(error instanceof A2AInvocationError);
      assert.equal(error.code, "A2A_REMOTE_REJECTED");
      assert.equal(error.remoteState, "rejected");
      return true;
    },
  );

  assert.deepEqual(
    emitted.map((event) => event.type),
    ["progress", "failed"],
  );
  assert.equal(emitted[1].errorCode, "A2A_REMOTE_REJECTED");
});

test("parseA2AInvocationPlan reuses the harness_agent_plan parser for remote text", () => {
  const result = {
    outputText: [
      "Remote worker response.",
      "",
      "```harness_agent_plan",
      JSON.stringify(
        {
          summary: "Remote worker proposes safe follow-up actions.",
          assumptions: [],
          steps: [
            {
              title: "Create file",
              rationale: "Capture remote worker result",
              risk: "medium",
            },
          ],
          proposedActions: [
            {
              type: "file_write",
              path: "remote.txt",
              after: "remote output\n",
              rationale: "persist remote result",
            },
            {
              type: "shell",
              command: "npm",
              args: ["run", "check"],
              rationale: "verify after approval",
            },
          ],
          suggestedQualityChecks: [],
          questions: [],
        },
        null,
        2,
      ),
      "```",
    ].join("\n"),
  };

  const parsed = parseA2AInvocationPlan(result);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.proposedActions.map((a) => a.type), [
    "file_write",
    "shell",
  ]);

  const workerOutcome = a2aInvocationToWorkerOutcome(result);
  assert.equal(workerOutcome.outputText, result.outputText);
  assert.deepEqual(workerOutcome.proposedActions, parsed.plan.proposedActions);
});

test("a2aInvocationToWorkerOutcome does not promote artifact payloads into proposed actions", () => {
  const result = {
    outputText: "Remote worker attached an artifact but did not emit a harness plan.",
    artifacts: [
      {
        remoteArtifactId: "artifact-with-actions",
        title: "actions.json",
        contentType: "application/json",
        data: {
          proposedActions: [
            {
              type: "file_write",
              path: "must-not-be-promoted.txt",
              after: "no\n",
              rationale: "artifact-only action",
            },
          ],
        },
      },
    ],
  };

  const parsed = parseA2AInvocationPlan(result);
  assert.equal(parsed.ok, false);

  const workerOutcome = a2aInvocationToWorkerOutcome(result);
  assert.deepEqual(workerOutcome, {
    outputText: result.outputText,
  });
});

test("a2aInvocationToWorkerOutcome refuses unsupported high-risk remote action types", () => {
  const result = {
    outputText: [
      "Remote worker response.",
      "",
      "```harness_agent_plan",
      JSON.stringify({
        summary: "Remote worker requested network access.",
        assumptions: [],
        steps: [],
        proposedActions: [
          {
            type: "network",
            url: "https://example.com",
            rationale: "remote follow-up",
          },
        ],
        suggestedQualityChecks: [],
        questions: [],
      }),
      "```",
    ].join("\n"),
  };

  const parsed = parseA2AInvocationPlan(result);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /proposedActions\[0\]\.type/);

  const workerOutcome = a2aInvocationToWorkerOutcome(result);
  assert.deepEqual(workerOutcome, {
    outputText: result.outputText,
  });
});
