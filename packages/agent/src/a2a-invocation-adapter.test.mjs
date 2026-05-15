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
