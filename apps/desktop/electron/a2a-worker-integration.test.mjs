import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2AInvocationError, A2AWorkerInvoker, A2AInvocationAdapter, OfficialA2AClientPort } from "@harness/agent";
import { OrchestrationPlanner, WorkerRunner } from "@harness/orchestration";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import {
  createA2AWorkerRouter,
  createPersistentA2AWorkerInvoker,
} from "./a2a-worker-composition.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-worker-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test("router shutdown aborts an active remote worker and drains it before refusing new work", async () => {
  let entered, release, aborted = false, calls = 0, stopped = false;
  const started = new Promise(resolve => { entered = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  const router = createA2AWorkerRouter({
    state: { a2aRemoteAgents: { getEndpoint: async () => ({ enabled: true, trusted: true }) } },
    localInvoker: { invokeForWorker: async () => assert.fail("remote must not route locally") },
    createRemoteInvoker: () => ({ invokeForWorker: async (_input, signal) => {
      calls++; entered();
      await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      await cleanup; throw new Error("remote aborted");
    } }),
  });
  const run = router.invokeForWorker({ remoteEndpointId: "owned-remote" }).catch(error => error);
  await started;
  const shutdown = router.shutdown().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); assert.equal(stopped, false);
  await assert.rejects(router.invokeForWorker({ remoteEndpointId: "new" }), /SHUTTING_DOWN/);
  release(); await shutdown; assert.match((await run).message, /remote aborted/);
  assert.equal(calls, 1); await router.shutdown();
});

const validProfileInput = (overrides = {}) => ({
  name: "RemoteReviewerProfile",
  description: "",
  category: "test",
  tags: ["reviewer"],
  provider: "codex",
  role: "reviewer",
  persona: "Review via remote A2A worker.",
  tuning: {
    model: "gpt-5.6-sol",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
    contextDepth: 5,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: false,
  ...overrides,
});

const seedTaskRun = async (state, targetDir) => {
  const thread = await state.createThread({ title: "A2A worker", targetDir });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "Run remote worker",
    targetDir,
    status: "running",
  });
};

for (const failure of ["discovery deadline", "response limit", "caller cancellation"]) {
  test(`persistent A2A records ${failure} without a successful output or new approval`, async () => {
    const db = openDb({ filePath: ":memory:" });
    try {
      const state = new LocalStateService(db), events = [];
      const task = await seedTaskRun(state, process.cwd());
      const profile = await state.agentProfiles.create(validProfileInput());
      const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "Limit fixture", baseUrl: "https://fixture.invalid",
        agentCardUrl: "https://fixture.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
      const controller = new AbortController();
      if (failure === "caller cancellation") controller.abort();
      let discoveries = 0;
      const port = new OfficialA2AClientPort({ endpoint, timeoutMs: 10, createClientFactory: () => ({ createFromUrl: () => {
        discoveries++;
        return new Promise(() => {});
      } }) });
      const adapter = new A2AInvocationAdapter({ limits: { maxTextBytes: 4 }, client: failure === "response limit" ? {
        async *invoke() { yield { type: "message", text: "too much text" }; yield { type: "task-state", state: "completed" }; },
      } : port });
      const invoker = createPersistentA2AWorkerInvoker({ state, endpoint, adapter, emitStreamEvent: event => events.push(event) });
      await assert.rejects(invoker.invokeForWorker({ taskRunId: task.id, profile, userRequest: "Inspect safely" }, controller.signal));
      const [invocation] = await state.listAgentInvocationsByTaskRun(task.id);
      assert.equal(invocation.status, failure === "caller cancellation" ? "cancelled" : "failed");
      assert.equal(invocation.errorCode, failure === "caller cancellation" ? "AbortError" : failure === "response limit" ? "A2A_RESPONSE_LIMIT" : "A2A_REQUEST_TIMEOUT");
      assert.equal(invocation.rawOutputArtifactId, undefined);
      assert.equal((await state.listApprovalsByTaskRun(task.id)).length, 0);
      assert.equal(events.some(event => event.type === "result"), false);
      assert.equal(discoveries, failure === "discovery deadline" ? 1 : 0);
    } finally { closeDb(db); }
  });
}

test("bounded official SDK output preserves proposal payload while persistent audit copies remain masked", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db), events = [];
    const task = await seedTaskRun(state, process.cwd());
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "SDK audit fixture", baseUrl: "https://fixture.invalid",
      agentCardUrl: "https://fixture.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
    const after = '{"token":"SYNTHETIC_SDK_EXECUTION_VALUE"}';
    const text = "```harness_agent_plan\n" + JSON.stringify({ summary: "proposed", assumptions: [], steps: [],
      proposedActions: [{ type: "file_write", path: "result.json", after, rationale: "requested output" }], suggestedQualityChecks: [], questions: [] }) + "\n```";
    let calls = 0;
    const port = new OfficialA2AClientPort({ endpoint, fetchImpl: async () => ++calls === 1 ? Response.json({ name: "Fixture", url: "https://fixture.invalid/rpc",
      version: "1", protocolVersion: "0.3.0", capabilities: { streaming: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] }) :
      new Response([{ kind: "message", parts: [{ kind: "text", text }] }, { kind: "status-update", taskId: "remote-sdk",
        status: { state: "completed" }, final: true }].map(result => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) });
    const invoker = createPersistentA2AWorkerInvoker({ state, endpoint, adapter: new A2AInvocationAdapter({ client: port }), emitStreamEvent: event => events.push(event) });
    const outcome = await invoker.invokeForWorker({ taskRunId: task.id, profile, userRequest: "Return a proposal" });
    assert.equal(outcome.proposedActions[0].after, after);
    assert.doesNotMatch(JSON.stringify(await state.listArtifactsByTaskRun(task.id)), /SYNTHETIC_SDK_EXECUTION_VALUE/);
    assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_SDK_EXECUTION_VALUE/);
    assert.equal((await state.listApprovalsByTaskRun(task.id)).length, 0, "the transport never executes or approves a proposal");
  } finally { closeDb(db); }
});

test("persistent A2A boundary redacts prompt, output and tool stream while preserving the actual request", async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const events = [];
  const userRequest = 'Inspect {"api_key":"SYNTHETIC_A2A_PROMPT"}';
  try {
    const taskRun = await seedTaskRun(state, process.cwd());
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "Redaction remote", baseUrl: "https://example.invalid/agent",
      agentCardUrl: "https://example.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
    const invoker = createPersistentA2AWorkerInvoker({ state, endpoint,
      emitStreamEvent: event => events.push(event), adapter: { async invoke(request, emit) {
        assert.match(request.message, /SYNTHETIC_A2A_PROMPT/, "redacting audit copies must not change the requested execution");
        emit({ type: "tool_call", invocationId: request.invocationId, toolName: "Read", phase: "started",
          input: { nested: [{ token: "SYNTHETIC_A2A_STREAM" }], tokenUsage: 8 } });
        emit({ type: "raw", invocationId: request.invocationId, source: "stdout", text: '{"api_' });
        emit({ type: "raw", invocationId: request.invocationId, source: "stdout", text: 'key":"SYNTHETIC_A2A_SPLIT_STREAM"}\n' });
        return { outputText: '{"token":"SYNTHETIC_A2A_OUTPUT","note":"safe result"}',
          remoteTask: { invocationId: request.invocationId, endpointId: endpoint.id, state: "completed" },
          artifacts: [], normalizedEvents: [], requiresInput: false, requiresAuth: false };
      } } });
    const outcome = await invoker.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest });
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.doesNotMatch(JSON.stringify(artifacts), /SYNTHETIC_A2A_/);
    assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_A2A_/);
    assert.match(outcome.outputText, /SYNTHETIC_A2A_OUTPUT/, "execution output stays intact; only its audit copies are masked");
    assert.match(outcome.outputText, /safe result/);
    assert.equal(events[0].input.tokenUsage, 8);
    assert.match(events.filter(event => event.type === "raw").map(event => event.text).join(""), /\[REDACTED\]/);
  } finally { closeDb(db); }
});

test("persistent A2A redaction preserves executable proposals and structured handoff bytes", async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const proposals = [
    { type: "file_write", path: "settings.txt", before: "token=SYNTHETIC_BEFORE", after: "token=SYNTHETIC_AFTER", rationale: "write exact requested contents" },
    { type: "file_patch", path: "patch.txt", patch: "--- a/patch.txt\n+++ b/patch.txt\n@@ -1 +1 @@\n-token=SYNTHETIC_BEFORE\n+token=SYNTHETIC_AFTER\n", rationale: "match the approved patch" },
    { type: "shell", command: "echo", args: ["token=SYNTHETIC_ARGUMENT"], rationale: "use the approved argument" },
  ];
  const rawOutput = "```harness_agent_plan\n" + JSON.stringify({ summary: "Prepare exact changes", assumptions: [], steps: [], proposedActions: proposals, suggestedQualityChecks: [], questions: [] }) +
    "\n```\n```harness_worker_handoff_v1\n" + JSON.stringify({ proposedActions: proposals }) + "\n```";
  try {
    const taskRun = await seedTaskRun(state, process.cwd());
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "Exact remote", baseUrl: "https://example.invalid/agent",
      agentCardUrl: "https://example.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
    const invoker = createPersistentA2AWorkerInvoker({ state, endpoint, adapter: { async invoke(request) {
      return { outputText: rawOutput, remoteTask: { invocationId: request.invocationId, endpointId: endpoint.id, state: "completed" },
        artifacts: [], normalizedEvents: [], requiresInput: false, requiresAuth: false };
    } } });
    const outcome = await invoker.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: "Prepare the exact approved edits" });
    assert.deepEqual(outcome.proposedActions, proposals);
    assert.equal(outcome.outputText, rawOutput);
    assert.doesNotMatch(JSON.stringify(await state.listArtifactsByTaskRun(taskRun.id)), /SYNTHETIC_BEFORE|SYNTHETIC_AFTER|SYNTHETIC_ARGUMENT/);
  } finally { closeDb(db); }
});

test("persistent A2A errors are redacted before SQLite storage and orchestration receives them", async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, process.cwd());
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "Error remote", baseUrl: "https://example.invalid/agent",
      agentCardUrl: "https://example.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
    const invoker = createPersistentA2AWorkerInvoker({ state, endpoint, adapter: { async invoke() {
      throw new A2AInvocationError("A2A_REMOTE_FAILED", "failed", '{"client_secret":"SYNTHETIC_A2A_ERROR"}');
    } } });
    await assert.rejects(invoker.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: "Inspect safely" }), error => {
      assert.equal(error.code, "A2A_REMOTE_FAILED");
      assert.equal(error.remoteState, "failed");
      assert.doesNotMatch(error.message, /SYNTHETIC_A2A_ERROR/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(await state.listAgentInvocationsByTaskRun(taskRun.id)), /SYNTHETIC_A2A_ERROR/);
  } finally { closeDb(db); }
});

test("persistent A2A does not persist or propagate credentials supplied as error name or code", async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, process.cwd());
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({ name: "Error identity remote", baseUrl: "https://example.invalid/agent",
      agentCardUrl: "https://example.invalid/card", preferredTransport: "json-rpc", enabled: true, trusted: true });
    const invoker = createPersistentA2AWorkerInvoker({ state, endpoint, adapter: { async invoke() {
      const error = new Error("remote request failed");
      error.name = "token=SYNTHETIC_ERROR_NAME";
      error.code = "token=SYNTHETIC_ERROR_CODE";
      throw error;
    } } });
    await assert.rejects(invoker.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: "Inspect safely" }), error => {
      assert.doesNotMatch(`${error.name} ${error.code} ${error.message}`, /SYNTHETIC_ERROR/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(await state.listAgentInvocationsByTaskRun(taskRun.id)), /SYNTHETIC_ERROR/);
  } finally { closeDb(db); }
});

const planText = [
  "Remote worker proposed a file write.",
  "",
  "```harness_agent_plan",
  JSON.stringify({
    summary: "Create a review artifact.",
    assumptions: [],
    steps: [],
    proposedActions: [
      {
        type: "file_write",
        path: "remote-review.md",
        after: "# Remote Review\n",
        rationale: "save remote review after approval",
      },
    ],
    suggestedQualityChecks: [],
    questions: [],
  }),
  "```",
].join("\n");

test("A2A worker output enters orchestration as pending approvals only", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, t.dir);
    const profile = await state.agentProfiles.create(validProfileInput());
    const pipeline = await state.agentPipelines.create({
      name: "Remote pipeline",
      description: "",
      steps: [
        {
          id: "remote-review",
          agentProfileId: profile.id,
          title: "Remote review",
          instruction: "Review and propose a file artifact.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const approved = await state.decideApproval(drafted.approval.id, "approved", "ok");
    const remoteRefs = [];
    const invoker = new A2AWorkerInvoker({
      endpointId: "endpoint_remote",
      createInvocationId: () => "inv_remote_worker",
      onRemoteTaskRef: (ref) => remoteRefs.push(ref),
      adapter: {
        async invoke(request) {
          return {
            outputText: planText,
            remoteTask: {
              invocationId: request.invocationId,
              endpointId: request.endpointId,
              remoteTaskId: "remote-task-worker",
              state: "completed",
              lastEventAt: "2026-05-15T00:00:00.000Z",
            },
            artifacts: [],
            normalizedEvents: [],
            requiresInput: false,
            requiresAuth: false,
          };
        },
      },
    });
    const runner = new WorkerRunner({ state, agentPlanning: invoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 1);
    const approval = await state.getApproval(result.proposedApprovalIds[0]);
    assert.equal(approval.status, "pending");
    assert.equal(approval.actionType, "file_write");
    assert.deepEqual(approval.proposedAction, {
      type: "file_write",
      filePatch: { path: "remote-review.md", after: "# Remote Review\n" },
    });
    assert.equal(existsSync(join(t.dir, "remote-review.md")), false);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "waiting_for_approval");
    assert.deepEqual(remoteRefs, [
      {
        invocationId: "inv_remote_worker",
        endpointId: "endpoint_remote",
        remoteTaskId: "remote-task-worker",
        state: "completed",
        lastEventAt: "2026-05-15T00:00:00.000Z",
      },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("persistent A2A worker composition records invocation, raw output, and remote task ref", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, t.dir);
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
      name: "Remote Reviewer",
      baseUrl: "https://agents.example.com/reviewer",
      agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
      preferredTransport: "json-rpc",
      enabled: true,
      trusted: true,
    });
    const pipeline = await state.agentPipelines.create({
      name: "Persistent remote pipeline",
      description: "",
      steps: [
        {
          id: "remote-review",
          agentProfileId: profile.id,
          title: "Remote review",
          instruction: "Review and propose a file artifact.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const approved = await state.decideApproval(drafted.approval.id, "approved", "ok");
    const streamEvents = [];
    const invoker = createPersistentA2AWorkerInvoker({
      state,
      endpoint,
      adapter: {
        async invoke(request, onEvent) {
          onEvent({
            type: "assistant_text",
            invocationId: request.invocationId,
            text: "remote stream chunk",
          });
          return {
            outputText: planText,
            remoteTask: {
              invocationId: request.invocationId,
              endpointId: request.endpointId,
              remoteTaskId: "remote-task-persistent",
              remoteContextId: "remote-context-persistent",
              state: "completed",
              lastEventAt: "2026-05-15T00:00:00.000Z",
            },
            artifacts: [],
            normalizedEvents: [],
            requiresInput: false,
            requiresAuth: false,
          };
        },
      },
      emitStreamEvent: (event) => streamEvents.push(event),
      now: () => "2026-05-15T00:00:00.000Z",
      createArtifactUriNonce: () => "nonce-1",
    });
    const runner = new WorkerRunner({ state, agentPlanning: invoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.equal(result.proposedApprovalIds.length, 1);
    const invocations = await state.listAgentInvocationsByTaskRun(taskRun.id);
    assert.equal(invocations.length, 1);
    const invocation = invocations[0];
    assert.equal(invocation.status, "succeeded");
    assert.equal(invocation.provider, "codex");
    assert.equal(invocation.model, `a2a:${endpoint.id}`);
    assert.ok(invocation.rawOutputArtifactId);
    assert.equal(invocation.startedAt, "2026-05-15T00:00:00.000Z");
    assert.equal(invocation.finishedAt, "2026-05-15T00:00:00.000Z");

    const remoteTask = await state.a2aRemoteAgents.getRemoteTaskRef(invocation.id);
    assert.deepEqual(remoteTask, {
      invocationId: invocation.id,
      endpointId: endpoint.id,
      remoteTaskId: "remote-task-persistent",
      remoteContextId: "remote-context-persistent",
      state: "completed",
      lastEventAt: "2026-05-15T00:00:00.000Z",
    });
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const promptArtifact = artifacts.find((a) => a.id === invocation.promptArtifactId);
    const rawOutputArtifact = artifacts.find((a) => a.id === invocation.rawOutputArtifactId);
    assert.equal(promptArtifact?.title, "A2A remote prompt: Remote Reviewer");
    assert.equal(rawOutputArtifact?.title, "A2A remote raw output: Remote Reviewer");
    assert.match(rawOutputArtifact?.summary ?? "", /Remote worker proposed a file write/);
    assert.deepEqual(streamEvents, [
      {
        type: "assistant_text",
        invocationId: invocation.id,
        taskRunId: taskRun.id,
        text: "remote stream chunk",
      },
    ]);
    assert.equal(existsSync(join(t.dir, "remote-review.md")), false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("persistent A2A worker pauses orchestration when remote input is required", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, t.dir);
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
      name: "Remote Reviewer",
      baseUrl: "https://agents.example.com/reviewer",
      agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
      preferredTransport: "json-rpc",
      enabled: true,
      trusted: true,
    });
    const pipeline = await state.agentPipelines.create({
      name: "Persistent remote input pipeline",
      description: "",
      steps: [
        {
          id: "remote-review",
          agentProfileId: profile.id,
          remoteEndpointId: endpoint.id,
          title: "Remote review",
          instruction: "Review and ask for missing input if needed.",
          expectedArtifactKinds: ["log"],
        },
      ],
    });
    const planner = new OrchestrationPlanner({ state });
    const drafted = await planner.draftPlan({
      taskRunId: taskRun.id,
      mode: "single_worker",
      pipelineId: pipeline.id,
    });
    const approved = await state.decideApproval(drafted.approval.id, "approved", "ok");
    const invoker = createPersistentA2AWorkerInvoker({
      state,
      endpoint,
      adapter: {
        async invoke(request) {
          return {
            outputText: "Which target branch should I use?",
            remoteTask: {
              invocationId: request.invocationId,
              endpointId: request.endpointId,
              remoteTaskId: "remote-task-input",
              remoteContextId: "remote-context-input",
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
      now: () => "2026-05-15T00:00:00.000Z",
      createArtifactUriNonce: () => "nonce-input",
    });
    const runner = new WorkerRunner({ state, agentPlanning: invoker });

    const result = await runner.runApproved({
      approval: approved,
      plan: drafted.plan,
    });

    assert.deepEqual(result.proposedApprovalIds, []);
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "paused");
    const invocations = await state.listAgentInvocationsByTaskRun(taskRun.id);
    assert.equal(invocations[0].status, "failed");
    assert.equal(invocations[0].errorCode, "A2A_REMOTE_INPUT_REQUIRED");
    const remoteTask = await state.a2aRemoteAgents.getRemoteTaskRef(invocations[0].id);
    assert.equal(remoteTask.state, "input-required");
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    const workerArtifact = artifacts.find((a) => a.title === "Worker output: Remote review");
    assert.match(workerArtifact?.summary ?? "", /requested input/i);
    assert.match(workerArtifact?.summary ?? "", /will not ask the user/i);
    assert.match(workerArtifact?.summary ?? "", /Which target branch/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2A worker router dispatches remote steps to endpoint invoker and keeps local steps local", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, t.dir);
    const profile = await state.agentProfiles.create(validProfileInput());
    const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
      name: "Remote Reviewer",
      baseUrl: "https://agents.example.com/reviewer",
      agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
      preferredTransport: "json-rpc",
      enabled: true,
      trusted: true,
    });
    const calls = [];
    const router = createA2AWorkerRouter({
      state,
      localInvoker: {
        async invokeForWorker(input) {
          calls.push({ route: "local", input });
          return { outputText: "LOCAL_OUTPUT" };
        },
      },
      createRemoteInvoker: (remoteEndpoint) => ({
        async invokeForWorker(input) {
          calls.push({ route: "remote", endpointId: remoteEndpoint.id, input });
          return { outputText: "REMOTE_OUTPUT" };
        },
      }),
    });

    const local = await router.invokeForWorker({
      taskRunId: taskRun.id,
      profile,
      userRequest: "Use local.",
    });
    const remote = await router.invokeForWorker({
      taskRunId: taskRun.id,
      profile,
      userRequest: "Use remote.",
      remoteEndpointId: endpoint.id,
    });

    assert.equal(local.outputText, "LOCAL_OUTPUT");
    assert.equal(remote.outputText, "REMOTE_OUTPUT");
    assert.deepEqual(
      calls.map((c) => c.route),
      ["local", "remote"],
    );
    assert.equal(calls[1].endpointId, endpoint.id);
    assert.equal(calls[1].input.remoteEndpointId, endpoint.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
