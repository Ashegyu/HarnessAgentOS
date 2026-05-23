import { test } from "node:test";
import assert from "node:assert/strict";
import { A2AWorkerInvoker } from "./a2a-worker-invoker.ts";

const profile = {
  id: "profile_1",
  name: "Remote Reviewer",
  provider: "codex",
  role: "reviewer",
};

const planText = [
  "Remote review complete.",
  "",
  "```harness_agent_plan",
  JSON.stringify({
    summary: "Remote worker proposed a follow-up edit.",
    assumptions: [],
    steps: [],
    proposedActions: [
      {
        type: "file_write",
        path: "remote-review.md",
        after: "# Review\n",
        rationale: "persist remote review",
      },
    ],
    suggestedQualityChecks: [],
    questions: [],
  }),
  "```",
].join("\n");

test("A2AWorkerInvoker wraps A2AInvocationAdapter as a WorkerCliInvoker", async () => {
  const requests = [];
  const streamEvents = [];
  const remoteRefs = [];
  const adapter = {
    async invoke(request, onEvent, signal) {
      requests.push({ request, signal });
      onEvent({
        type: "progress",
        invocationId: request.invocationId,
        taskRunId: request.taskRunId,
        stage: "complete",
        message: "remote complete",
        at: "2026-05-15T00:00:00.000Z",
      });
      return {
        outputText: planText,
        remoteTask: {
          invocationId: request.invocationId,
          endpointId: request.endpointId,
          remoteTaskId: "remote-task-1",
          state: "completed",
          lastEventAt: "2026-05-15T00:00:00.000Z",
        },
        artifacts: [],
        normalizedEvents: [],
        requiresInput: false,
        requiresAuth: false,
      };
    },
  };
  const invoker = new A2AWorkerInvoker({
    endpointId: "endpoint_1",
    adapter,
    createInvocationId: () => "inv_a2a_worker_1",
    onStreamEvent: (event) => streamEvents.push(event),
    onRemoteTaskRef: (ref) => remoteRefs.push(ref),
  });

  const outcome = await invoker.invokeForWorker({
    taskRunId: "task_run_1",
    profile,
    userRequest: "Review the implementation.",
  });

  assert.equal(requests[0].request.invocationId, "inv_a2a_worker_1");
  assert.equal(requests[0].request.taskRunId, "task_run_1");
  assert.equal(requests[0].request.endpointId, "endpoint_1");
  assert.match(requests[0].request.message, /FINAL NON-INTERACTIVE POLICY/);
  assert.match(requests[0].request.message, /Do not ask the user follow-up questions/);
  assert.match(requests[0].request.message, /questions:\s*\[\]/);
  assert.match(requests[0].request.message, /USER REQUEST\n\nReview the implementation\./);
  assert.equal(streamEvents[0].type, "progress");
  assert.deepEqual(remoteRefs, [
    {
      invocationId: "inv_a2a_worker_1",
      endpointId: "endpoint_1",
      remoteTaskId: "remote-task-1",
      state: "completed",
      lastEventAt: "2026-05-15T00:00:00.000Z",
    },
  ]);
  assert.equal(outcome.outputText, planText);
  assert.deepEqual(outcome.proposedActions, [
    {
      type: "file_write",
      path: "remote-review.md",
      after: "# Review\n",
      rationale: "persist remote review",
    },
  ]);
});

test("A2AWorkerInvoker surfaces input-required as a lifecycle interruption", async () => {
  const remoteRefs = [];
  const invoker = new A2AWorkerInvoker({
    endpointId: "endpoint_input",
    adapter: {
      async invoke(request) {
        return {
          outputText: "Need target branch before continuing.",
          remoteTask: {
            invocationId: request.invocationId,
            endpointId: request.endpointId,
            remoteTaskId: "remote-task-input",
            state: "input-required",
            lastEventAt: "2026-05-15T00:00:00.000Z",
          },
          artifacts: [],
          normalizedEvents: [],
          requiresInput: true,
          requiresAuth: false,
        };
      },
    },
    createInvocationId: () => "inv_a2a_input",
    onRemoteTaskRef: (ref) => remoteRefs.push(ref),
  });

  const outcome = await invoker.invokeForWorker({
    taskRunId: "task_run_input",
    profile,
    userRequest: "Continue remote work.",
  });

  assert.deepEqual(outcome.lifecycle, {
    kind: "requires_input",
    remoteState: "input-required",
    message: "Remote A2A worker requested input; Harness will proceed only through assumptions or backflow",
  });
  assert.equal(outcome.proposedActions, undefined);
  assert.equal(remoteRefs[0].state, "input-required");
});

test("A2AWorkerInvoker surfaces auth-required as a lifecycle interruption", async () => {
  const invoker = new A2AWorkerInvoker({
    endpointId: "endpoint_auth",
    adapter: {
      async invoke(request) {
        return {
          outputText: "",
          remoteTask: {
            invocationId: request.invocationId,
            endpointId: request.endpointId,
            remoteTaskId: "remote-task-auth",
            state: "auth-required",
            lastEventAt: "2026-05-15T00:00:00.000Z",
          },
          artifacts: [],
          normalizedEvents: [],
          requiresInput: false,
          requiresAuth: true,
        };
      },
    },
    createInvocationId: () => "inv_a2a_auth",
  });

  const outcome = await invoker.invokeForWorker({
    taskRunId: "task_run_auth",
    profile,
    userRequest: "Continue remote work.",
  });

  assert.deepEqual(outcome.lifecycle, {
    kind: "requires_auth",
    remoteState: "auth-required",
    message: "Remote A2A worker requires authentication",
  });
});
