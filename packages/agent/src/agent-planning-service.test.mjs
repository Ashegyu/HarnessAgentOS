import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  buildTaskContract,
} from "@harness/core";
import { AgentPlanningService } from "./agent-planning-service.ts";

const preparationCancellationFixture = (hooks = {}) => {
  const taskRun = {
    id: "tr-preparation-cancel", threadId: "th-preparation-cancel",
    userRequest: "inspect and update the project", targetDir: process.cwd(),
    status: "drafting", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let invocation;
  let sequence = 0;
  let modelCalls = 0;
  const invocationStatuses = [];
  const taskStatuses = [];
  const artifacts = [];
  const approvals = [];
  const state = makeGateway({
    getTaskRun: async () => ({ ...taskRun }),
    createStep: async input => ({ id: `step-${++sequence}`, ...input }),
    setStepStatus: async (id, status, patch) => ({ id, status, ...patch }),
    setTaskRunStatus: async (_id, status) => {
      taskStatuses.push(status);
      taskRun.status = status;
      return { ...taskRun };
    },
    setTaskRunCurrentStep: async () => ({ ...taskRun }),
    createArtifact: async input => {
      const artifact = { id: `artifact-${++sequence}`, ...input };
      artifacts.push(artifact);
      return artifact;
    },
    createAgentInvocation: async input => {
      invocation = { id: "inv-preparation-cancel", status: "queued", ...input };
      await hooks.afterInvocationCreated?.();
      return { ...invocation };
    },
    getAgentInvocation: async () => invocation ? { ...invocation } : null,
    listAgentInvocationsByTaskRun: async () => invocation ? [{ ...invocation }] : [],
    updateAgentInvocation: async (_id, patch) => {
      if (patch.status) invocationStatuses.push(patch.status);
      invocation = { ...invocation, ...patch };
      return { ...invocation };
    },
    createCheckpoint: async input => ({ id: "checkpoint-preparation-cancel", ...input }),
    createApproval: async input => {
      const approval = { id: `approval-${++sequence}`, ...input };
      approvals.push(approval);
      return approval;
    },
  });
  const service = new AgentPlanningService({
    state,
    getProviderStatus: () => ({ codex: { available: true, queueDepth: 0 } }),
    workspaceChangeTracker: null,
    adapter: {
      invoke: async (...args) => {
        modelCalls++;
        if (hooks.invoke) return hooks.invoke(...args);
        throw new Error("model must not start after cancellation");
      },
    },
    ...hooks,
  });
  return {
    service, state, taskRun, invocationStatuses, taskStatuses, artifacts, approvals,
    get invocation() { return invocation; },
    get modelCalls() { return modelCalls; },
    run: kind => kind === "worker"
      ? service.invokeForWorker({ taskRunId: taskRun.id, stepId: "worker-step", profile: workerProfile(), userRequest: taskRun.userRequest })
      : service.generatePlan({ taskRunId: taskRun.id }),
  };
};

for (const kind of ["planner", "worker"]) {
  test(`${kind} shutdown owns invocation publication before its controller is registered`, { timeout: 2000 }, async () => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const published = new Promise(resolve => { entered = resolve; });
    const f = preparationCancellationFixture({ afterInvocationCreated: async () => { entered(); await gate; } });
    const result = f.run(kind).catch(error => error);
    await published;
    let stopped = false;
    const shutdown = f.service.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release(); await shutdown;
    assert.equal((await result).code, "AGENT_CANCELLED");
    assert.equal(f.invocation.status, "cancelled"); assert.equal(f.modelCalls, 0);
  });

  test(`${kind} shutdown retains storage ownership when cancellation finalization fails`, { timeout: 2000 }, async () => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = preparationCancellationFixture({ invoke: async (_request, _event, signal) => {
      entered(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      throw Object.assign(new Error("cancelled"), { code: "AGENT_CANCELLED" });
    } });
    const run = f.run(kind).catch(error => error);
    await started;
    if (kind === "planner") {
      const persist = f.state.setStepStatus;
      f.state.setStepStatus = async (...args) => {
        if (args[1] === "failed") throw Object.assign(new Error("fixture storage busy"), { code: "SQLITE_BUSY" });
        return persist(...args);
      };
    } else {
      const persist = f.state.updateAgentInvocation;
      let cancellations = 0;
      f.state.updateAgentInvocation = async (...args) => {
        if (args[1].status === "cancelled" && ++cancellations > 1) {
          throw Object.assign(new Error("fixture storage busy"), { code: "SQLITE_BUSY" });
        }
        return persist(...args);
      };
    }
    await assert.rejects(f.service.shutdown(), /storage busy/);
    await run;
  });

  test(`${kind} shutdown reports unconfirmed process cleanup instead of declaring the scope safe`, { timeout: 2000 }, async () => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = preparationCancellationFixture({ invoke: async (_request, _event, signal) => {
      entered();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("fixture cleanup failed");
      error.processCleanupConfirmed = false;
      throw error;
    } });
    const run = f.run(kind).catch(error => error);
    await started;
    await assert.rejects(f.service.shutdown(), /cleanup.*confirmed/i);
    assert.equal((await run).code, "AGENT_CANCELLED");
  });

  test(`${kind} shutdown seals entry and waits for preparation cleanup before returning`, { timeout: 2000 }, async () => {
    let release, entered, cleanup = 0;
    const preparation = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const f = preparationCancellationFixture({ prepareMcpInvocation: async () => {
      entered(); await preparation;
      return { codexConfigOverrides: [], cleanup: async () => { cleanup++; } };
    } });
    const run = f.run(kind);
    const result = run.then(() => null, error => error);
    try {
      await started;
      let finished = false;
      const stopping = f.service.shutdown().then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false);
      assert.equal(f.invocation.status, "cancelled");
      await assert.rejects(f.run(kind), error => error.code === "AGENT_CANCELLED");
      release();
      await stopping;
      assert.equal((await result).code, "AGENT_CANCELLED");
      assert.equal(f.modelCalls, 0);
      assert.equal(cleanup, 1);
      await f.service.shutdown();
    } finally { release(); await result; }
  });

  test(`${kind} preserves cancellation when failure persistence loses to cancelInvocation`, { timeout: 2_000 }, async () => {
    const { openDb, closeDb, LocalStateService } = await import("../../storage/src/index.ts");
    const db = openDb({ filePath: ":memory:" });
    const failedWriteEntered = deferred();
    const allowFailedWrite = deferred();
    let outcome;
    try {
      const state = new LocalStateService(db);
      const thread = await state.createThread({ title: "failure cancellation race", targetDir: process.cwd() });
      const taskRun = await state.createTaskRun({ threadId: thread.id, targetDir: process.cwd(), userRequest: "inspect project" });
      const profile = await state.agentProfiles.create({ ...workerProfile(), category: "core", tags: [] });
      state.getSettings = makeGateway().getSettings;
      state.listAgentProfiles = async () => [];
      const persistInvocation = state.updateAgentInvocation.bind(state);
      state.updateAgentInvocation = async (id, patch) => {
        if (patch.status === "failed") {
          failedWriteEntered.resolve(id);
          await allowFailedWrite.promise;
        }
        return persistInvocation(id, patch);
      };
      const service = new AgentPlanningService({
        state,
        getProviderStatus: () => ({ codex: { available: true, queueDepth: 0 } }),
        workspaceChangeTracker: null,
        adapter: { invoke: async () => { throw new Error("provider failed before cancellation"); } },
      });
      outcome = (kind === "worker"
        ? service.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: taskRun.userRequest })
        : service.generatePlan({ taskRunId: taskRun.id })).catch(error => error);
      const invocationId = await failedWriteEntered.promise;
      assert.equal((await service.cancelInvocation({ invocationId })).status, "cancelled");
      allowFailedWrite.resolve();
      const error = await outcome;
      assert.equal(error.code, "AGENT_CANCELLED");
      assert.equal((await state.getAgentInvocation(invocationId)).status, "cancelled");
      assert.notEqual((await state.getTaskRun(taskRun.id)).status, "blocked",
        "a late provider failure must not block a task after its invocation was cancelled");
    } finally {
      allowFailedWrite.resolve();
      await outcome;
      closeDb(db);
    }
  });

  test(`${kind} observes cancellation before invocation creation resolves`, { timeout: 2_000 }, async () => {
    const entered = deferred();
    const creation = deferred();
    const fixture = preparationCancellationFixture({
      afterInvocationCreated: async () => { entered.resolve(); await creation.promise; },
    });
    const outcome = fixture.run(kind).catch(error => error);
    await entered.promise;
    await fixture.service.cancelInvocation({ invocationId: fixture.invocation.id });
    creation.resolve();
    const error = await outcome;
    assert.equal(error.code, "AGENT_CANCELLED");
    assert.equal(fixture.modelCalls, 0);
    assert.equal(fixture.invocation.status, "cancelled");
    assert.equal(fixture.invocationStatuses.includes("running"), false);
  });

  for (const preparationFails of [false, true]) {
    test(`${kind} cancellation during MCP preparation prevents invocation even when preparation ${preparationFails ? "fails" : "succeeds"}`, { timeout: 2_000 }, async () => {
      const entered = deferred();
      const preparation = deferred();
      let cleanupCalls = 0;
      const fixture = preparationCancellationFixture({
        prepareMcpInvocation: async () => {
          entered.resolve();
          await preparation.promise;
          return { codexConfigOverrides: [], cleanup: async () => { cleanupCalls++; } };
        },
      });
      const outcome = fixture.run(kind).catch(error => error);
      await entered.promise;
      fixture.taskRun.status = "cancelled";
      await fixture.service.cancelTaskInvocations({ taskRunId: fixture.taskRun.id });
      if (preparationFails) preparation.reject(new Error("MCP preparation failed after cancellation"));
      else preparation.resolve();
      const error = await outcome;
      assert.equal(fixture.modelCalls, 0, "a cancelled preparation must never reach the model");
      assert.equal(error.code, "AGENT_CANCELLED");
      assert.equal(fixture.invocation?.status, "cancelled");
      assert.equal(fixture.invocationStatuses.includes("failed"), false);
      assert.equal(fixture.taskStatuses.includes("blocked"), false);
      assert.equal(cleanupCalls, preparationFails ? 0 : 1);
      assert.equal(fixture.service.getQueueDepths().total, 0);
    });
  }

  test(`${kind} cancellation during advisory preparation prevents enqueue and cleans MCP once`, { timeout: 2_000 }, async () => {
    const entered = deferred();
    const advisory = deferred();
    let cleanupCalls = 0;
    const fixture = preparationCancellationFixture({
      prepareMcpInvocation: async () => ({ codexConfigOverrides: [], cleanup: async () => { cleanupCalls++; } }),
      recordLearnerSelection: async () => { entered.resolve(); await advisory.promise; },
    });
    const outcome = fixture.run(kind).catch(error => error);
    await entered.promise;
    await fixture.service.cancelInvocation({ invocationId: fixture.invocation.id });
    advisory.resolve();
    const error = await outcome;
    assert.equal(fixture.modelCalls, 0);
    assert.equal(error.code, "AGENT_CANCELLED");
    assert.equal(fixture.invocation.status, "cancelled");
    assert.equal(fixture.invocationStatuses.includes("failed"), false);
    assert.equal(cleanupCalls, 1);
  });

  test(`${kind} ignores a successful late model result after cancellation`, { timeout: 2_000 }, async () => {
    const entered = deferred();
    const response = deferred();
    const fixture = preparationCancellationFixture({
      invoke: async () => { entered.resolve(); return response.promise; },
    });
    const outcome = fixture.run(kind).catch(error => error);
    await entered.promise;
    await fixture.service.cancelInvocation({ invocationId: fixture.invocation.id });
    response.resolve({ provider: "codex", model: "test", exitCode: 0, stderr: "", normalizedEvents: [], latencyMs: 1,
      stdout: "```harness_agent_plan\n" + JSON.stringify({ summary: "late success", assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] }) + "\n```" });
    const error = await outcome;
    assert.equal(error.code, "AGENT_CANCELLED");
    assert.equal(fixture.invocation.status, "cancelled");
    assert.equal(fixture.invocationStatuses.includes("succeeded"), false);
    assert.equal(fixture.approvals.length, 0);
    assert.equal(fixture.taskStatuses.includes("ready_for_review"), false);
  });
}

test("cancelInvocation does not abort work when successful completion wins the persistence race", async () => {
  let aborts = 0;
  const invocation = { id: "inv-finished-race", status: "running" };
  const service = new AgentPlanningService({
    state: makeGateway({
      getAgentInvocation: async () => invocation,
      updateAgentInvocation: async () => ({ ...invocation, status: "succeeded" }),
    }),
    getProviderStatus: () => null,
    queue: { cancel: () => { aborts++; } },
  });
  assert.equal((await service.cancelInvocation({ invocationId: invocation.id })).status, "succeeded");
  assert.equal(aborts, 0);
});

/**
 * Minimal gateway stub that satisfies AgentPlanningStateGateway
 * without importing anything from @harness/storage.
 */
const makeGateway = (overrides = {}) => ({
  getTaskRun: async () => null,
  listStepsByTaskRun: async () => [],
  createStep: async (_input) => { throw new Error("not implemented"); },
  listArtifactsByTaskRun: async () => [],
  getLatestQualityGateResult: async () => null,
  createArtifact: async (_input) => { throw new Error("not implemented"); },
  createAgentInvocation: async (_input) => { throw new Error("not implemented"); },
  updateAgentInvocation: async (_id, _patch) => { throw new Error("not implemented"); },
  setStepStatus: async (_id, _status, _patch) => { throw new Error("not implemented"); },
  setTaskRunStatus: async (_id, _status) => { throw new Error("not implemented"); },
  createCheckpoint: async (_input) => { throw new Error("not implemented"); },
  createApproval: async (_input) => { throw new Error("not implemented"); },
  setApprovalProposedAction: async (_id, _details) => { throw new Error("not implemented"); },
  setTaskRunCurrentStep: async (_id, _stepId) => { throw new Error("not implemented"); },
  getAgentInvocation: async () => null,
  getThread: async () => null,
  setThreadAgentSession: async (_threadId, _sessionId) => ({
    id: _threadId,
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  // Phase 4 gateway additions — empty profiles + default settings keep
  // existing tests on the legacy fallback path so behavior is unchanged.
  listAgentProfiles: async () => [],
  getSettings: async () => ({
    agent: {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
    },
    orchestration: {
      enabled: false,
      defaultMode: "single_worker",
      defaultInstructions: "",
      workerProfiles: [],
    },
    approval: { autoApprove: false },
  }),
  ...overrides,
});

const parseJsonLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

const deferred = () => {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
};

test("persisted read-only intent overrides global writes and worker instructions without MCP preparation", async () => {
  const taskRun = { id: "tr-contract", threadId: "th-contract", targetDir: process.cwd(),
    userRequest: "implement feature", status: "drafting",
    contract: buildTaskContract({ userRequest: "implement feature", intent: "review" }),
    createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z" };
  const profile = codexProfile({ id: "ap-contract", tuning: { model: "gpt-5.6-luna" } });
  let seq = 0;
  const requests = [];
  const artifacts = [];
  const state = makeGateway({
    getTaskRun: async () => taskRun,
    listAgentProfiles: async () => [profile],
    getSettings: async () => ({ ...(await makeGateway().getSettings()),
      activeAgentProfileId: profile.id,
      agent: { ...(await makeGateway().getSettings()).agent, codexWorkspaceWrite: true, codexAutoReview: true } }),
    createStep: async (input) => ({ id: `step-${++seq}`, ...input }),
    createArtifact: async (input) => { const row = { id: `art-${++seq}`, ...input }; artifacts.push(row); return row; },
    createAgentInvocation: async (input) => ({ id: `inv-${++seq}`, ...input }),
    updateAgentInvocation: async (id, patch) => ({ id, ...patch }),
    setStepStatus: async (id, status) => ({ id, status }),
    setTaskRunStatus: async () => taskRun,
    setTaskRunCurrentStep: async () => taskRun,
    createCheckpoint: async (input) => ({ id: `cp-${++seq}`, ...input }),
    createApproval: async () => { assert.fail("read-only response must not create file approvals"); },
  });
  const service = new AgentPlanningService({ state,
    getProviderStatus: () => ({ codex: { available: true, queueDepth: 0 } }),
    getApprovedLearnerModel: async () => ({ model: "gpt-6-astra", reason: "old recommendation" }),
    prepareMcpInvocation: async () => { assert.fail("read-only task must not prepare profile MCP"); },
    adapter: { invoke: async (request) => {
      requests.push(request);
      const plan = { summary: "Reviewed", assumptions: [], steps: [], questions: [], suggestedQualityChecks: [],
        proposedActions: [{ type: "file_write", path: "unexpected.txt", after: "unsafe", rationale: "model suggestion" }] };
      return { provider: "codex", model: "gpt-5.6-sol", exitCode: 0, stderr: "", normalizedEvents: [], latencyMs: 1,
        stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(plan)}\n\`\`\`` };
    } },
  });
  const plan = await service.generatePlan({ taskRunId: taskRun.id });
  assert.deepEqual(plan.approvals, []);
  const worker = await service.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: "delete and rewrite files" });
  assert.deepEqual(worker.proposedActions ?? [], []);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.sandbox.mode, "read-only");
    assert.equal(request.sandbox.autoReview, false);
    assert.equal(request.sandbox.readOnlyTask, true);
    assert.equal(request.modelConfig.model, "gpt-5.6-luna", "saved profile pin must beat an older learner recommendation");
    assert.match(request.systemPrompt, /Intent: review/);
    assert.equal(request.outputContract.intent, "review");
    assert.equal(request.outputContract.authorization.mode, "read_only");
    assert.match(request.systemPrompt, /STRICT JSON v1/);
    assert.doesNotMatch(request.systemPrompt, /Then a single fenced JSON block/);
  }
  assert.ok(artifacts.some((row) => /read-only task contract/.test(row.summary)));
});

for (const budget of [{ perInvocationUsd: 0.1 }, { perTaskRunUsd: 1 }, { perDayUsd: 5 }]) {
  test(`planner and parallel workers reject unverified USD budget before model/MCP preparation ${JSON.stringify(budget)}`, async () => {
    const taskRun = { id: "tr-budget", threadId: "th-budget", targetDir: process.cwd(), userRequest: "수정해줘", status: "drafting" };
    const profile = codexProfile({ id: "ap-budget", permissions: { budget } });
    let modelCalls = 0;
    const steps = [];
    let status = taskRun.status;
    const service = new AgentPlanningService({
      state: makeGateway({ getTaskRun: async () => taskRun, listAgentProfiles: async () => [profile],
        listStepsByTaskRun: async () => steps,
        createStep: async input => { const step = { id: `step-${steps.length}`, ...input }; steps.push(step); return step; },
        setStepStatus: async (id, status, patch) => { const step = steps.find(row => row.id === id); Object.assign(step, { status }, patch); return step; },
        setTaskRunStatus: async (_id, next) => { status = next; return { ...taskRun, status }; },
        getSettings: async () => ({ ...(await makeGateway().getSettings()), activeAgentProfileId: profile.id }) }),
      getProviderStatus: () => ({ codex: { available: true, queueDepth: 0 } }),
      prepareMcpInvocation: async () => assert.fail("budget must be checked before external tool preparation"),
      adapter: { invoke: async () => { modelCalls += 1; throw new Error("must not invoke"); } },
    });
    const attempts = [service.generatePlan({ taskRunId: taskRun.id }), ...[1, 2].map(() => service.invokeForWorker({ taskRunId: taskRun.id, profile, userRequest: "수정해줘" }))];
    for (const result of await Promise.allSettled(attempts)) {
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.code, "AGENT_BUDGET_UNVERIFIABLE");
    }
    assert.equal(modelCalls, 0);
    assert.equal(status, "blocked", "a rejected start must not leave the task drafting forever");
    assert.ok(steps.some(step => step.status === "failed" && step.outputSummary?.includes("AGENT_BUDGET_UNVERIFIABLE")));
  });
}

test("malformed worker output fails rather than recording success or producing approvals", async () => {
  const patches = [];
  const artifacts = [];
  const events = [];
  const taskRun = { id: "tr-invalid-worker", threadId: "th-invalid-worker", targetDir: process.cwd(), userRequest: "수정해줘", status: "drafting" };
  const service = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      createArtifact: async input => { const row = { id: `art-${artifacts.length}`, ...input }; artifacts.push(row); return row; },
      createAgentInvocation: async input => ({ id: "inv-invalid-worker", ...input }),
      updateAgentInvocation: async (id, patch) => { patches.push(patch); return { id, ...patch }; },
      createApproval: async () => assert.fail("invalid output must not create approval"),
    }),
    getProviderStatus: () => ({ codex: { available: true, queueDepth: 0 } }),
    emit: event => events.push(event),
    adapter: { invoke: async () => ({ provider: "codex", model: "gpt-5.6-sol", exitCode: 0, stdout: "invalid output", stderr: "", normalizedEvents: [], latencyMs: 1 }) },
  });
  await assert.rejects(service.invokeForWorker({ taskRunId: taskRun.id, profile: workerProfile(), userRequest: "수정해줘" }), { code: "AGENT_INVALID_OUTPUT" });
  assert.equal(patches.some(p => p.status === "succeeded"), false);
  assert.equal(patches.at(-1).status, "failed");
  assert.equal(patches.at(-1).errorCode, "AGENT_INVALID_OUTPUT");
  assert.ok(artifacts.some(a => a.title.startsWith("Worker diagnostic log")));
});

test("generatePlan persists post-hoc workspace change evidence for workspace-write", async () => {
  const targetDir = await mkdtemp(join(tmpdir(), "harness-plan-evidence-"));
  let mutationActive = 0;
  const mutationEvents = [];
  try {
    await writeFile(join(targetDir, "README.md"), "before\n", "utf8");
    const taskRun = {
      id: "tr-workspace-evidence",
      threadId: "th-workspace-evidence",
      userRequest: "update files directly",
      targetDir,
      status: "drafting",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const profile = codexProfile({
      id: "ap-workspace-evidence",
      name: "Workspace Writer",
    });
    const artifacts = [];
    let artifactSeq = 0;
    let stepSeq = 0;
    const invocation = {
      id: "inv-workspace-evidence",
      taskRunId: taskRun.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      status: "queued",
      promptArtifactId: "art-prompt",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const planOutput = {
      summary: "Updated workspace",
      assumptions: [],
      steps: [{ title: "Edit", rationale: "requested", risk: "low" }],
      proposedActions: [],
      suggestedQualityChecks: [],
      questions: [],
    };
    const svc = new AgentPlanningService({
      state: makeGateway({
        beginWorkspaceMutation: async cwd => {
          assert.equal(cwd, targetDir);
          mutationActive += 1;
          mutationEvents.push("begin");
          return "direct-workspace-mutation";
        },
        endWorkspaceMutation: async token => {
          assert.equal(token, "direct-workspace-mutation");
          mutationActive -= 1;
          mutationEvents.push("end");
        },
        getTaskRun: async () => taskRun,
        createStep: async (input) => ({
          id: `step-${++stepSeq}`,
          taskRunId: input.taskRunId,
          index: input.index,
          kind: input.kind,
          title: input.title,
          status: input.status,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        createArtifact: async (input) => {
          const artifact = {
            id: `art-${++artifactSeq}`,
            ...input,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
          artifacts.push(artifact);
          return artifact;
        },
        createAgentInvocation: async () => invocation,
        updateAgentInvocation: async (_id, patch) => ({ ...invocation, ...patch }),
        setStepStatus: async (id, status) => ({
          id,
          taskRunId: taskRun.id,
          index: 0,
          kind: "plan",
          title: "Agent plan",
          status,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        setTaskRunStatus: async () => taskRun,
        setTaskRunCurrentStep: async () => taskRun,
        createCheckpoint: async (input) => ({
          id: "cp-workspace-evidence",
          ...input,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        listAgentProfiles: async () => [profile],
        getSettings: async () => ({
          activeAgentProfileId: profile.id,
          agent: {
            provider: "codex",
            model: "gpt-5.6-sol",
            timeoutMs: 300_000,
            stallTimeoutMs: 60_000,
            contextDepth: 5,
            codexWorkspaceWrite: true,
            codexAutoReview: true,
          },
          orchestration: {
            enabled: false,
            defaultMode: "single_worker",
            defaultInstructions: "",
            workerProfiles: [],
          },
          approval: { autoApprove: false },
        }),
      }),
      getProviderStatus: () =>
        /** @type {any} */ ({
          codex: { available: true, queueDepth: 0 },
        }),
      modelInvoker: {
        invoke: async (request) => {
          assert.equal(mutationActive, 1, "direct provider writes must own the shared workspace epoch");
          await writeFile(join(request.cwd, "README.md"), "after\n", "utf8");
          await writeFile(join(request.cwd, "generated.txt"), "created\n", "utf8");
          return {
            provider: "codex",
            model: "gpt-5.6-sol",
            exitCode: 0,
            stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
            stderr: "",
            normalizedEvents: [],
            latencyMs: 10,
          };
        },
      },
    });

    await svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" });
    assert.equal(mutationActive, 0);
    assert.deepEqual(mutationEvents, ["begin", "end"]);

    const evidence = artifacts.find(
      (artifact) => artifact.title === "Workspace change evidence",
    );
    assert.equal(evidence?.kind, "diff");
    assert.match(evidence?.summary ?? "", /M README\.md/);
    assert.match(evidence?.summary ?? "", /A generated\.txt/);
    assert.match(evidence?.summary ?? "", /-before/);
    assert.match(evidence?.summary ?? "", /\+after/);
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("getQueueDepths reports empty provider queues for idle service", () => {
  const svc = new AgentPlanningService({
    state: makeGateway(),
    getProviderStatus: () => null,
  });
  assert.deepEqual(svc.getQueueDepths(), {
    codex: 0,
    total: 0,
  });
});

const workerProfile = (overrides = {}) => ({
  id: "ap-worker",
  name: "Worker",
  description: "",
  provider: "codex",
  role: "coder",
  persona: "Be precise.",
  tuning: {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

for (const kind of ["planner", "worker"]) {
  test(`${kind} sends regression review to the adapter while preserving the proposed answer`, async () => {
    let request;
    const summary = "C# test proposal; compilation and execution are unverified.";
    const fixture = preparationCancellationFixture({
      invoke: async input => {
        request = input;
        return { provider: "codex", model: "test", exitCode: 0, stderr: "", normalizedEvents: [], latencyMs: 1,
          stdout: "```harness_agent_plan\n" + JSON.stringify({ summary, assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] }) + "\n```" };
      },
    });
    fixture.taskRun.userRequest = "C# 회귀 검사를 작성해줘. 검사는 실행하지 마.";
    try {
      await fixture.run(kind);
      assert.equal(fixture.modelCalls, 1);
      assert.match(request.systemPrompt, /REGRESSION TEST REVIEW/);
      assert.match(request.systemPrompt, /validation before the first await/i);
      assert.match(request.systemPrompt.replace(/\s+/g, " "), /final CR.*does not.*make otherwise valid JSON invalid/i);
      assert.match(request.systemPrompt, /unexecuted.*unverified/i);
      assert.equal(fixture.approvals.length, 0);
      assert.ok(fixture.artifacts.some(a => a.summary?.includes(summary)), "the host must not silently rewrite generated test answers");
    } finally { await fixture.service.shutdown(); }
  });
}

test("local worker tool inputs mask nested secret keys before stream and artifact publication", async () => {
  const events = [];
  const input = { credentials: { token: "SYNTHETIC_LOCAL_TOKEN" }, nested: [{ api_key: "SYNTHETIC_LOCAL_KEY" }], tokenUsage: 5 };
  const fixture = preparationCancellationFixture({
    emitStreamEvent: event => events.push(event),
    invoke: async (request, onEvent) => {
      onEvent({ type: "tool_call", invocationId: request.invocationId, phase: "started", toolName: "Read", input });
      return { provider: "codex", model: "test", exitCode: 0, stderr: "", normalizedEvents: [], latencyMs: 1,
        stdout: "```harness_agent_plan\n" + JSON.stringify({ summary: "safe answer", assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] }) + "\n```" };
    },
  });
  await fixture.run("worker");
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_LOCAL/);
  assert.doesNotMatch(JSON.stringify(fixture.artifacts), /SYNTHETIC_LOCAL/);
  assert.equal(events.find(event => event.type === "tool_call").input.tokenUsage, 5);
  assert.equal(input.nested[0].api_key, "SYNTHETIC_LOCAL_KEY", "redaction must not mutate the model's event input");
});

for (const kind of ["planner", "worker"]) {
  test(`${kind} masks a sensitive JSON key split across raw stream chunks`, async () => {
    const events = [];
    const fixture = preparationCancellationFixture({
      emitStreamEvent: event => events.push(event),
      invoke: async (request, onEvent) => {
        onEvent({ type: "raw", invocationId: request.invocationId, source: "stdout", text: '{"to' });
        onEvent({ type: "tool_call", invocationId: request.invocationId, phase: "started", toolName: "Read", input: { path: "safe.txt" } });
        onEvent({ type: "raw", invocationId: request.invocationId, source: "stdout", text: 'ken":"SYNTHETIC_SPLIT_STREAM_SECRET"}\n' });
        return { provider: "codex", model: "test", exitCode: 0, stderr: "", normalizedEvents: [], latencyMs: 1,
          stdout: "```harness_agent_plan\n" + JSON.stringify({ summary: "safe answer", assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] }) + "\n```" };
      },
    });
    await fixture.run(kind);
    assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_SPLIT_STREAM_SECRET/);
    assert.doesNotMatch(JSON.stringify(fixture.artifacts), /SYNTHETIC_SPLIT_STREAM_SECRET/);
    assert.deepEqual(events.filter(e => e.type === "raw" || e.type === "tool_call").map(e => e.type), ["raw", "tool_call", "raw"]);
    assert.ok(events.filter(e => e.type === "raw").map(e => e.text).join("").includes("[REDACTED]"));
  });

  test(`${kind} always cleans MCP resources when flushing audit events throws`, async () => {
    let cleanupCalls = 0;
    const fixture = preparationCancellationFixture({
      prepareMcpInvocation: async () => ({ codexConfigOverrides: [], cleanup: async () => { cleanupCalls += 1; } }),
      emitStreamEvent: event => { if (event.type === "raw") throw new Error("audit consumer failed"); },
      invoke: async (request, onEvent) => {
        onEvent({ type: "raw", invocationId: request.invocationId, source: "stdout", text: "pending audit fragment" });
        throw new Error("provider failed");
      },
    });
    await assert.rejects(fixture.run(kind));
    assert.equal(cleanupCalls, 1, "audit callbacks cannot bypass invocation-owned cleanup");
  });
}

const codexProfile = (overrides = {}) => {
  const base = workerProfile({
    provider: "codex",
    tuning: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
  });
  return {
    ...base,
    ...overrides,
    tuning: { ...base.tuning, ...(overrides.tuning ?? {}) },
    permissions: { ...base.permissions, ...(overrides.permissions ?? {}) },
  };
};

test("cancelInvocation rejects unknown invocationId with AGENT_INVOCATION_NOT_FOUND", async () => {
  const svc = new AgentPlanningService({
    state: makeGateway(),
    getProviderStatus: () => null,
  });
  await assert.rejects(
    () => svc.cancelInvocation({ invocationId: "unknown-id" }),
    (err) => err.constructor.name === "AgentPlanningError" && err.code === "AGENT_INVOCATION_NOT_FOUND",
  );
});

test("AgentPlanningService defaults allow long-running agent work", () => {
  const svc = new AgentPlanningService({
    state: makeGateway(),
    getProviderStatus: () => null,
  });
  assert.equal(svc.defaults.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
  assert.equal(svc.defaults.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS);
});

test("cancelInvocation returns immediately if invocation already succeeded", async () => {
  const succeeded = {
    id: "inv-1",
    taskRunId: "tr-1",
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "succeeded",
    promptArtifactId: "art-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  const svc = new AgentPlanningService({
    state: makeGateway({ getAgentInvocation: async () => succeeded }),
    getProviderStatus: () => null,
  });
  const result = await svc.cancelInvocation({ invocationId: "inv-1" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.id, "inv-1");
});

test("cancelTaskInvocations cancels every queued or running invocation for the task", async () => {
  const invocations = [
    { id: "inv-queued", taskRunId: "tr-wave", provider: "codex", model: "gpt-5.6-sol", status: "queued", promptArtifactId: "a1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "inv-running", taskRunId: "tr-wave", provider: "codex", model: "gpt-5.6-sol", status: "running", promptArtifactId: "a2", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "inv-done", taskRunId: "tr-wave", provider: "codex", model: "gpt-5.6-sol", status: "succeeded", promptArtifactId: "a3", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const updates = [];
  const svc = new AgentPlanningService({
    state: makeGateway({
      listAgentInvocationsByTaskRun: async () => invocations,
      getAgentInvocation: async (id) => invocations.find((item) => item.id === id) ?? null,
      updateAgentInvocation: async (id, patch) => {
        updates.push([id, patch.status]);
        return { ...invocations.find((item) => item.id === id), ...patch };
      },
    }),
    getProviderStatus: () => null,
  });

  const cancelled = await svc.cancelTaskInvocations({ taskRunId: "tr-wave" });

  assert.deepEqual(cancelled.map((item) => item.id), ["inv-queued", "inv-running"]);
  assert.deepEqual(updates, [
    ["inv-queued", "cancelled"],
    ["inv-running", "cancelled"],
  ]);
});

test("retryInvocation rejects unknown invocationId with AGENT_INVOCATION_NOT_FOUND", async () => {
  const svc = new AgentPlanningService({
    state: makeGateway(),
    getProviderStatus: () => null,
  });
  await assert.rejects(
    () => svc.retryInvocation({ invocationId: "unknown-id" }),
    (err) => err.constructor.name === "AgentPlanningError" && err.code === "AGENT_INVOCATION_NOT_FOUND",
  );
});

test("generatePlan accepts quality_failed TaskRun for repair loop entry", async () => {
  const taskRun = {
    id: "tr-quality-failed",
    threadId: "th-1",
    userRequest: "repair",
    targetDir: "/tmp",
    status: "quality_failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const svc = new AgentPlanningService({
    state: makeGateway({ getTaskRun: async () => taskRun }),
    getProviderStatus: () => ({ codex: { available: false } }),
  });
  await assert.rejects(
    () => svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" }),
    (err) =>
      err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE",
  );
});

test("generatePlan marks invocation cancelled (not failed) when queue rejects with AGENT_CANCELLED", async () => {
  const draftingTaskRun = {
    id: "tr-cancel",
    threadId: "th-1",
    userRequest: "do something",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseInvocation = {
    id: "inv-cancel",
    taskRunId: "tr-cancel",
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "running",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  const invocationStatuses = [];
  const taskRunStatuses = [];
  const baseArtifact = {
    id: "art-1",
    taskRunId: "tr-cancel",
    stepId: "step-1",
    kind: "log",
    title: "...",
    uri: "harness:x/1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => draftingTaskRun,
      createStep: async () => ({
        id: "step-1", taskRunId: "tr-cancel", index: 0, kind: "plan",
        title: "Agent plan", status: "running",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async () => baseArtifact,
      createAgentInvocation: async () => baseInvocation,
      updateAgentInvocation: async (_id, patch) => {
        if (patch.status !== undefined) invocationStatuses.push(patch.status);
        return { ...baseInvocation, ...patch };
      },
      setStepStatus: async () => ({
        id: "step-1", taskRunId: "tr-cancel", index: 0, kind: "plan",
        title: "Agent plan", status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:02.000Z",
      }),
      setTaskRunStatus: async (_id, status) => { taskRunStatuses.push(status); },
    }),
    getProviderStatus: () => /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    adapter: {
      invoke: async () => { throw { code: "AGENT_CANCELLED", message: "Cancelled by user" }; },
    },
    defaults: { timeoutMs: 100, stallTimeoutMs: 50 },
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-cancel", provider: "codex" }),
    (err) => {
      assert.equal(err.constructor.name, "AgentPlanningError",
        `Expected AgentPlanningError but got ${err.constructor.name}: ${err.message}`);
      assert.equal(err.code, "AGENT_CANCELLED");
      return true;
    },
  );

  assert.ok(
    invocationStatuses.includes("cancelled"),
    `Expected invocation to be marked cancelled; got: ${JSON.stringify(invocationStatuses)}`,
  );
  assert.ok(
    !invocationStatuses.includes("failed"),
    `Invocation must not be marked failed on cancellation; got: ${JSON.stringify(invocationStatuses)}`,
  );
  assert.ok(
    !taskRunStatuses.includes("blocked"),
    `Task run must not be blocked on cancellation; got: ${JSON.stringify(taskRunStatuses)}`,
  );
});

test("generatePlan throws AGENT_PROVIDER_UNAVAILABLE (not TypeError) when providers map omits the requested provider", async () => {
  const draftingTaskRun = {
    id: "tr-draft",
    threadId: "th-1",
    userRequest: "do something",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const svc = new AgentPlanningService({
    state: makeGateway({ getTaskRun: async () => draftingTaskRun }),
    // Non-null map but the Codex entry is absent (sparse mock).
    getProviderStatus: () => /** @type {any} */ ({}),
  });
  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-draft", provider: "codex" }),
    (err) => {
      assert.equal(err.constructor.name, "AgentPlanningError",
        `Expected AgentPlanningError but got ${err.constructor.name}: ${err.message}`);
      assert.equal(err.code, "AGENT_PROVIDER_UNAVAILABLE");
      return true;
    },
  );
});

test("generatePlan persists a diagnostic log artifact when CLI invocation fails", async () => {
  const draftingTaskRun = {
    id: "tr-cli-fail",
    threadId: "th-1",
    userRequest: "do something",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseInvocation = {
    id: "inv-cli-fail",
    taskRunId: "tr-cli-fail",
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "running",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  let artifactSeq = 0;
  const artifacts = [];
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => draftingTaskRun,
      createStep: async () => ({
        id: "step-cli-fail",
        taskRunId: "tr-cli-fail",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => {
        const artifact = {
          id: `art-${++artifactSeq}`,
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          summary: input.summary,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        artifacts.push(artifact);
        return artifact;
      },
      createAgentInvocation: async () => baseInvocation,
      updateAgentInvocation: async (_id, patch) => ({
        ...baseInvocation,
        ...patch,
      }),
      setStepStatus: async () => ({
        id: "step-cli-fail",
        taskRunId: "tr-cli-fail",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
      setTaskRunStatus: async () => {},
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    adapter: {
      invoke: async () => {
        throw new Error("spawn failed with api_key=super-secret-value");
      },
    },
    defaults: { timeoutMs: 100, stallTimeoutMs: 50 },
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-cli-fail", provider: "codex" }),
    (err) => err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE",
  );

  const diagnostic = artifacts.find(
    (artifact) =>
      artifact.kind === "log" && artifact.title === "Agent diagnostic log",
  );
  assert.ok(diagnostic, "diagnostic log artifact must be persisted");
  assert.match(diagnostic.summary ?? "", /agent.generatePlan.cli/);
  assert.match(diagnostic.summary ?? "", /AGENT_PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(diagnostic.summary ?? "", /super-secret-value/);
});

test("generatePlan records failed pinned context outcome when CLI invocation fails", async () => {
  const draftingTaskRun = {
    id: "tr-cli-fail-context",
    threadId: "th-1",
    userRequest: "do something",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseInvocation = {
    id: "inv-cli-fail-context",
    taskRunId: "tr-cli-fail-context",
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "running",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  let artifactSeq = 0;
  const outcomes = [];
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => draftingTaskRun,
      createStep: async () => ({
        id: "step-cli-fail-context",
        taskRunId: "tr-cli-fail-context",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => ({
        id: `art-${++artifactSeq}`,
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createAgentInvocation: async () => baseInvocation,
      updateAgentInvocation: async (_id, patch) => ({
        ...baseInvocation,
        ...patch,
      }),
      setStepStatus: async () => ({
        id: "step-cli-fail-context",
        taskRunId: "tr-cli-fail-context",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
      setTaskRunStatus: async () => {},
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    recordContextPackObservation: async () => ({ id: "obs-context-pack" }),
    recordPinnedContextOutcome: async (input) => {
      outcomes.push(input);
    },
    adapter: {
      invoke: async () => {
        throw new Error("spawn failed with api_key=super-secret-value");
      },
    },
    defaults: { timeoutMs: 100, stallTimeoutMs: 50 },
  });

  await assert.rejects(
    () =>
      svc.generatePlan({
        taskRunId: "tr-cli-fail-context",
        provider: "codex",
        pinnedObservationContexts: [
          {
            observationId: "obs-prior-failure",
            taskRunId: "tr-prior",
            threadId: "th-prior",
            projectKey: "proj_context",
            source: "quality",
            eventType: "failed",
            signal: "failed",
            summary: "Prior failure included SECRET_TOKEN=abc123.",
            score: 0.91,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    (err) =>
      err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE",
  );

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].taskRun.id, "tr-cli-fail-context");
  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].errorCode, "AGENT_PROVIDER_UNAVAILABLE");
  assert.equal(outcomes[0].contextPackObservationId, "obs-context-pack");
  assert.equal(outcomes[0].contextPackArtifactId, "art-2");
  assert.deepEqual(outcomes[0].pinnedObservationIds, ["obs-prior-failure"]);
  assert.match(outcomes[0].summary, /agent planning failed/i);
  assert.doesNotMatch(JSON.stringify(outcomes[0]), /super-secret-value/);
  assert.doesNotMatch(JSON.stringify(outcomes[0]), /SECRET_TOKEN/);
});

test("generatePlan emits progress events before and after CLI invocation", async () => {
  const draftingTaskRun = {
    id: "tr-progress",
    threadId: "th-progress",
    userRequest: "explain current project",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseInvocation = {
    id: "inv-progress",
    taskRunId: "tr-progress",
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let artifactSeq = 0;
  let stepSeq = 0;
  const createStepInputs = [];
  const events = [];
  const artifacts = [];
  const learnerSelections = [];
  let capabilityContextInput = null;
  let activeInstinctInput = null;
  let contextPackObservationInput = null;
  const activeProfile = {
    id: "ap-progress",
    name: "LocalPlanner",
    description: "",
    provider: "codex",
    role: "planner",
    persona: "Plan precisely.",
    tuning: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
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
    isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const rawProviderOutput =
    '{"type":"item.completed","item":{"type":"assistant_message","role":"assistant","content":[{"type":"output_text","text":"raw stream answer"}]}}\n';
  let lastRequest = null;
  let adapterSignal = null;
  let createAgentInvocationInput = null;
  const planOutput = {
    summary: "Project explained",
    assumptions: [],
    steps: [{ title: "Explain", rationale: "answer only", risk: "low" }],
    proposedActions: [],
    suggestedQualityChecks: [],
    questions: [],
  };
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => draftingTaskRun,
      createStep: async (input) => {
        createStepInputs.push(input);
        return {
          id: `step-${++stepSeq}`,
          taskRunId: input.taskRunId,
          index: input.index,
          kind: input.kind,
          title: input.title,
          status: input.status,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
      createArtifact: async (input) => {
        const artifact = {
          id: `art-${++artifactSeq}`,
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          summary: input.summary,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        artifacts.push(artifact);
        return artifact;
      },
      createAgentInvocation: async (input) => {
        createAgentInvocationInput = input;
        return baseInvocation;
      },
      updateAgentInvocation: async (_id, patch) => ({
        ...baseInvocation,
        ...patch,
      }),
      setStepStatus: async (id, status) => ({
        id,
        taskRunId: "tr-progress",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      setTaskRunStatus: async () => {},
      setTaskRunCurrentStep: async () => {},
      createCheckpoint: async (input) => ({
        id: "cp-1",
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        reason: input.reason,
        stateRef: input.stateRef,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      listAgentProfiles: async () => [activeProfile],
      getSettings: async () => ({
        activeAgentProfileId: activeProfile.id,
        agent: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
        },
        orchestration: {
          enabled: false,
          defaultMode: "single_worker",
          defaultInstructions: "",
          workerProfiles: [],
        },
        approval: { autoApprove: false },
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    getApprovedCapabilityContexts: async (input) => {
      capabilityContextInput = input;
      return [];
    },
    getActiveInstincts: async (input) => {
      activeInstinctInput = input;
      return [
        {
          id: "instinct_quality_evidence",
          projectKey: "proj_progress",
          scope: "project",
          title: "Prevent repeated quality gate failures",
          rule: "Require stronger evidence before marking similar work ready for review.",
          rationale: "3 matching observations for quality:failed:failed.",
          confidence: 0.7,
          status: "active",
          sourceObservationIds: ["obs_1", "obs_2", "obs_3"],
          tags: ["evolved"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    },
    recordContextPackObservation: async (input) => {
      contextPackObservationInput = input;
    },
    recordLearnerSelection: async (input) => {
      learnerSelections.push(input);
    },
    emitStreamEvent: (event) => events.push(event),
    adapter: {
      invoke: async (request, onEvent, signal) => {
        lastRequest = request;
        adapterSignal = signal;
        onEvent({
          type: "started",
          invocationId: request.invocationId,
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
        });
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          rawStdout: rawProviderOutput,
          stderr: "",
          normalizedEvents: [],
          latencyMs: 10,
        };
      },
    },
  });

  await svc.generatePlan({
    taskRunId: "tr-progress",
    provider: "codex",
    pinnedObservationContexts: [
      {
        observationId: "obs-quality-repair",
        taskRunId: "tr-prior",
        threadId: "th-prior",
        projectKey: "proj_progress",
        source: "quality",
        eventType: "quality_gate",
        signal: "failed",
        summary: "A previous repair succeeded only after rebuilding better-sqlite3.",
        score: 0.91,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(capabilityContextInput, {
    taskRunId: "tr-progress",
    profileId: activeProfile.id,
  });
  assert.deepEqual(activeInstinctInput, {
    taskRun: draftingTaskRun,
    profileId: activeProfile.id,
  });
  assert.match(lastRequest.prompt, /ACTIVE INSTINCTS/);
  assert.match(lastRequest.prompt, /Prevent repeated quality gate failures/);
  assert.match(lastRequest.prompt, /PINNED OBSERVATION CONTEXT/);
  assert.match(lastRequest.prompt, /obs-quality-repair/);
  const contextPackArtifact = artifacts.find(
    (artifact) => artifact.title === "Agent context pack",
  );
  assert.equal(contextPackArtifact?.kind, "snapshot");
  assert.match(contextPackArtifact?.summary ?? "", /# Agent Context Pack/);
  assert.match(contextPackArtifact?.summary ?? "", /active instincts: 1/);
  assert.match(contextPackArtifact?.summary ?? "", /approved capabilities: 0/);
  assert.match(contextPackArtifact?.summary ?? "", /pinned observations: 1/);
  assert.match(contextPackArtifact?.summary ?? "", /instinct_quality_evidence/);
  assert.match(contextPackArtifact?.summary ?? "", /obs-quality-repair/);
  assert.equal(contextPackObservationInput?.taskRun.id, "tr-progress");
  assert.equal(contextPackObservationInput?.contextPack.taskRunId, "tr-progress");
  assert.equal(
    contextPackObservationInput?.contextPackArtifactId,
    contextPackArtifact?.id,
  );
  assert.deepEqual(contextPackObservationInput?.contextPack.counts, {
    instincts: 1,
    capabilities: 0,
    qualityRisks: 0,
    threadTasks: 0,
    recentArtifacts: 0,
    repoFiles: 0,
    pinnedObservations: 1,
  });
  assert.equal(createAgentInvocationInput?.profileId, activeProfile.id);
  assert.deepEqual(learnerSelections, [
    {
      taskRunId: "tr-progress",
      selectedModel: "gpt-5.6-sol",
    },
  ]);
  assert.equal(adapterSignal instanceof AbortSignal, true);
  assert.equal(
    createStepInputs[0]?.title,
    "Agent[LocalPlanner] plan (codex:gpt-5.6-sol)",
  );
  const progress = events.filter((event) => event.type === "progress");
  assert.deepEqual(
    progress.map((event) => event.stage),
    ["context", "profile", "prompt", "session", "mcp", "queued", "cli", "parse", "approval", "complete"],
  );
  assert.ok(progress.every((event) => event.taskRunId === "tr-progress"));
  assert.ok(progress.every((event) => event.invocationId === "inv-progress"));
  const persisted = parseJsonLines(
    artifacts.find((artifact) => artifact.title === "Agent raw output")?.summary ?? "",
  );
  assert.deepEqual(
    persisted.filter((event) => event.type === "progress").map((event) => event.stage),
    ["context", "profile", "prompt", "session", "mcp", "queued", "cli"],
  );
  assert.ok(
    persisted.some(
      (event) => event.type === "raw" && event.text === rawProviderOutput,
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.type === "assistant_text" && event.text.includes("Project explained"),
    ),
  );
  assert.ok(persisted.some((event) => event.type === "result"));
});

test("generatePlan uses approved Learner model recommendation when no explicit model is supplied", async () => {
  const draftingTaskRun = {
    id: "tr-learner-model",
    threadId: "th-learner-model",
    userRequest: "explain current project",
    targetDir: "/tmp",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseInvocation = {
    id: "inv-learner-model",
    taskRunId: "tr-learner-model",
    provider: "codex",
    model: "gpt-5.6-terra",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const planOutput = {
    summary: "Project explained",
    assumptions: [],
    steps: [{ title: "Explain", rationale: "answer only", risk: "low" }],
    proposedActions: [],
    suggestedQualityChecks: [],
    questions: [],
  };
  let stepSeq = 0;
  let artifactSeq = 0;
  let lastRequest = null;
  const selections = [];
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => draftingTaskRun,
      createStep: async (input) => ({
        id: `step-${++stepSeq}`,
        taskRunId: input.taskRunId,
        index: input.index,
        kind: input.kind,
        title: input.title,
        status: input.status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => ({
        id: `art-${++artifactSeq}`,
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createAgentInvocation: async (input) => ({
        ...baseInvocation,
        provider: input.provider,
        model: input.model,
      }),
      updateAgentInvocation: async (_id, patch) => ({
        ...baseInvocation,
        ...patch,
      }),
      setStepStatus: async (id, status) => ({
        id,
        taskRunId: "tr-learner-model",
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      setTaskRunStatus: async () => {},
      setTaskRunCurrentStep: async () => {},
      createCheckpoint: async (input) => ({
        id: "cp-learner-model",
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        reason: input.reason,
        stateRef: input.stateRef,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
    getApprovedLearnerModel: async () => ({
      model: "gpt-5.6-terra",
      reason: "Highest avg reward",
      recommendationId: "rec_learner",
      confidence: 0.8,
    }),
    recordLearnerSelection: async (input) => {
      selections.push(input);
    },
    adapter: {
      invoke: async (request) => {
        lastRequest = request;
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          stderr: "",
          normalizedEvents: [],
          latencyMs: 10,
        };
      },
    },
  });

  const result = await svc.generatePlan({ taskRunId: "tr-learner-model" });

  assert.equal(result.invocation.provider, "codex");
  assert.equal(result.invocation.model, "gpt-5.6-terra");
  assert.equal(lastRequest.modelConfig.provider, "codex");
  assert.equal(lastRequest.modelConfig.model, "gpt-5.6-terra");
  assert.deepEqual(selections, [
    { taskRunId: "tr-learner-model", selectedModel: "gpt-5.6-terra" },
  ]);
});

test("generatePlan rejects Codex profiles with unsupported tool policy", async () => {
  const taskRun = {
    id: "tr-codex-policy",
    threadId: "th-codex-policy",
    userRequest: "read current project",
    targetDir: "/tmp/project",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = codexProfile({
    id: "ap-codex-policy",
    permissions: {
      toolAllowlist: ["Read"],
    },
  });
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      listAgentProfiles: async () => [profile],
      getSettings: async () => ({
        activeAgentProfileId: profile.id,
        agent: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
        },
        orchestration: {
          enabled: false,
          defaultMode: "single_worker",
          defaultInstructions: "",
          workerProfiles: [],
        },
        approval: { autoApprove: false },
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" }),
    (err) =>
      err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE" &&
      /Codex provider cannot enforce AgentProfile tool policy/.test(err.message),
  );
});

test("generatePlan passes Codex MCP config overrides for MCP-bound profiles", async () => {
  const taskRun = {
    id: "tr-codex-mcp",
    threadId: "th-codex-mcp",
    userRequest: "use repo mcp",
    targetDir: "/tmp/project",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = codexProfile({
    id: "ap-codex-mcp",
    name: "Codex MCP",
    tuning: { reasoningEffort: "xhigh" },
    mcpServerIds: ["mcp_repo"],
  });
  const baseInvocation = {
    id: "inv-codex-mcp",
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const artifacts = [];
  const events = [];
  let artifactSeq = 0;
  let stepSeq = 0;
  let lastRequest = null;
  let createAgentInvocationInput = null;
  let prepareInput = null;
  let cleanupCalled = false;
  const codexConfigOverrides = [
    'mcp_servers.repo_mcp.command="node"',
    'mcp_servers.repo_mcp.args=["server.mjs"]',
  ];
  const planOutput = {
    summary: "Repo MCP ready",
    assumptions: [],
    steps: [{ title: "Use MCP", rationale: "repo context", risk: "low" }],
    proposedActions: [],
    suggestedQualityChecks: [],
    questions: [],
  };
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      createStep: async (input) => ({
        id: `step-${++stepSeq}`,
        taskRunId: input.taskRunId,
        index: input.index,
        kind: input.kind,
        title: input.title,
        status: input.status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => {
        const artifact = {
          id: `art-${++artifactSeq}`,
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          summary: input.summary,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        artifacts.push(artifact);
        return artifact;
      },
      createAgentInvocation: async (input) => {
        createAgentInvocationInput = input;
        return baseInvocation;
      },
      updateAgentInvocation: async (_id, patch) => ({
        ...baseInvocation,
        ...patch,
      }),
      setStepStatus: async (id, status) => ({
        id,
        taskRunId: taskRun.id,
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      setTaskRunStatus: async () => {},
      setTaskRunCurrentStep: async () => {},
      createCheckpoint: async (input) => ({
        id: "cp-codex-mcp",
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        reason: input.reason,
        stateRef: input.stateRef,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      listAgentProfiles: async () => [profile],
      getSettings: async () => ({
        activeAgentProfileId: profile.id,
        agent: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
          codexWorkspaceWrite: true,
          codexAutoReview: true,
        },
        orchestration: {
          enabled: false,
          defaultMode: "single_worker",
          defaultInstructions: "",
          workerProfiles: [],
        },
        approval: { autoApprove: false },
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
    prepareMcpInvocation: async (input) => {
      prepareInput = input;
      return {
        mcpConfigPath: null,
        codexConfigOverrides,
        cleanup: async () => {
          cleanupCalled = true;
        },
      };
    },
    emitStreamEvent: (event) => events.push(event),
    workspaceChangeTracker: null,
    adapter: {
      invoke: async (request) => {
        lastRequest = request;
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          rawStdout: "",
          stderr: "",
          normalizedEvents: [],
          latencyMs: 10,
        };
      },
    },
  });

  await svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" });

  assert.deepEqual(prepareInput, {
    profileId: profile.id,
    provider: "codex",
  });
  assert.equal(createAgentInvocationInput?.profileId, profile.id);
  assert.equal(lastRequest.modelConfig.reasoningEffort, "xhigh");
  assert.equal(lastRequest.sandbox.mode, "workspace-write");
  assert.equal(lastRequest.sandbox.autoReview, true);
  assert.match(lastRequest.systemPrompt, /workspace-write sandbox/);
  assert.deepEqual(lastRequest.codexConfigOverrides, codexConfigOverrides);
  assert.equal(lastRequest.mcpConfigPath, undefined);
  assert.equal(cleanupCalled, true);
  assert.equal(
    events.find((event) => event.type === "progress" && event.stage === "mcp")
      ?.message,
    "MCP 설정 준비 완료",
  );
});

test("generatePlan includes previous TaskRuns from the same thread in the prompt", async () => {
  const taskRun = {
    id: "tr-current-thread",
    threadId: "th-thread-context",
    userRequest: "이어서 마무리해줘",
    targetDir: "/tmp/project",
    status: "drafting",
    followUpTaskRunId: "tr-prev-thread",
    createdAt: "2026-01-01T00:10:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
  };
  const previousTaskRun = {
    id: "tr-prev-thread",
    threadId: taskRun.threadId,
    userRequest: "그래프 연결선을 고쳐줘",
    targetDir: "/tmp/project",
    status: "ready_for_review",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
  };
  const invocation = {
    id: "inv-thread-context",
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:10:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
  };
  const planOutput = {
    summary: "Thread context used",
    assumptions: [],
    steps: [{ title: "Continue", rationale: "same thread", risk: "low" }],
    proposedActions: [],
    suggestedQualityChecks: [],
    questions: [],
  };
  let lastRequest = null;
  let promptArtifactSummary = "";
  let artifactSeq = 0;
  let stepSeq = 0;
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      getThreadDetail: async () => ({
        thread: {
          id: taskRun.threadId,
          title: "Thread",
          targetDir: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:10:00.000Z",
        },
        taskRuns: [taskRun, previousTaskRun],
        agentAnswers: {
          [previousTaskRun.id]: "포트 중심 좌표로 연결선 보정 완료",
        },
      }),
      createStep: async (input) => ({
        id: `step-${++stepSeq}`,
        taskRunId: input.taskRunId,
        index: input.index,
        kind: input.kind,
        title: input.title,
        status: input.status,
        createdAt: "2026-01-01T00:10:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
      }),
      createArtifact: async (input) => {
        if (input.title === "Agent prompt") promptArtifactSummary = input.summary;
        return {
          id: `art-${++artifactSeq}`,
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          summary: input.summary,
          createdAt: "2026-01-01T00:10:00.000Z",
          updatedAt: "2026-01-01T00:10:00.000Z",
        };
      },
      createAgentInvocation: async () => invocation,
      updateAgentInvocation: async (_id, patch) => ({
        ...invocation,
        ...patch,
      }),
      setStepStatus: async (id, status) => ({
        id,
        taskRunId: taskRun.id,
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status,
        createdAt: "2026-01-01T00:10:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
      }),
      setTaskRunStatus: async (_id, status) => ({ ...taskRun, status }),
      setTaskRunCurrentStep: async (_id, stepId) => ({ ...taskRun, currentStepId: stepId }),
      createCheckpoint: async (input) => ({
        id: "cp-thread-context",
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        reason: input.reason,
        stateRef: input.stateRef,
        summary: input.summary,
        createdAt: "2026-01-01T00:10:00.000Z",
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
    adapter: {
      invoke: async (request) => {
        lastRequest = request;
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          stderr: "",
          normalizedEvents: [],
          latencyMs: 10,
        };
      },
    },
  });

  await svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" });

  assert.match(lastRequest.prompt, /THREAD CONTEXT/);
  assert.match(lastRequest.prompt, /FOLLOW-UP ANCHOR/);
  assert.match(lastRequest.prompt, /continuation of this specific previous TaskRun/);
  assert.match(lastRequest.prompt, /그래프 연결선을 고쳐줘/);
  assert.match(lastRequest.prompt, /포트 중심 좌표로 연결선 보정 완료/);
  assert.doesNotMatch(lastRequest.prompt, /Task 2[\s\S]*이어서 마무리해줘/);
  assert.match(promptArtifactSummary, /THREAD CONTEXT/);
  assert.match(promptArtifactSummary, /FOLLOW-UP ANCHOR/);
});

test("generatePlan persists captured token usage instead of misleading retained metadata", async () => {
  const taskRun = {
    id: "tr-token-usage",
    threadId: "th-token-usage",
    userRequest: "measure tokens",
    targetDir: "/tmp/project",
    status: "drafting",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = codexProfile({
    id: "ap-token-usage",
    name: "Token Usage",
  });
  const invocation = {
    id: "inv-token-usage",
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const planOutput = {
    summary: "Token usage captured",
    assumptions: [],
    steps: [{ title: "Report", rationale: "answer only", risk: "low" }],
    proposedActions: [],
    suggestedQualityChecks: [],
    questions: [],
  };
  const updatePatches = [];
  let artifactSeq = 0;
  let stepSeq = 0;
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      createStep: async (input) => ({
        id: `step-${++stepSeq}`,
        taskRunId: input.taskRunId,
        index: input.index,
        kind: input.kind,
        title: input.title,
        status: input.status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => ({
        id: `art-${++artifactSeq}`,
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createAgentInvocation: async () => invocation,
      updateAgentInvocation: async (_id, patch) => {
        updatePatches.push(patch);
        return { ...invocation, ...patch };
      },
      setStepStatus: async (id, status) => ({
        id,
        taskRunId: taskRun.id,
        index: 0,
        kind: "plan",
        title: "Agent plan",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      setTaskRunStatus: async () => {},
      setTaskRunCurrentStep: async () => {},
      createCheckpoint: async (input) => ({
        id: "cp-token-usage",
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        reason: input.reason,
        stateRef: input.stateRef,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      listAgentProfiles: async () => [profile],
      getSettings: async () => ({
        activeAgentProfileId: profile.id,
        agent: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
        },
        orchestration: {
          enabled: false,
          defaultMode: "single_worker",
          defaultInstructions: "",
          workerProfiles: [],
        },
        approval: { autoApprove: false },
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
    adapter: {
      invoke: async (request) => ({
        provider: request.modelConfig.provider,
        model: request.modelConfig.model,
        exitCode: 0,
        stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
        rawStdout: JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            reasoning_output_tokens: 5,
          },
        }),
        tokenUsage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 40, reasoningOutputTokens: 5 },
        stderr: "",
        normalizedEvents: [],
        latencyMs: 10,
      }),
    },
  });

  await svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" });

  const usagePatch = updatePatches.find(
    (patch) => patch.rawOutputArtifactId !== undefined,
  );
  assert.equal(usagePatch.inputTokens, 100);
  assert.equal(usagePatch.outputTokens, 25);
  assert.equal(usagePatch.totalTokens, 125);
  assert.equal(usagePatch.usageApproximate, false);
});

test("invokeForWorker rejects Codex profiles with unsupported tool policy", async () => {
  const taskRun = {
    id: "tr-codex-worker-policy",
    threadId: "th-codex-worker-policy",
    userRequest: "original request",
    targetDir: "/tmp/project",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = codexProfile({
    id: "ap-codex-worker-policy",
    permissions: {
      toolDenylist: ["Read"],
    },
  });
  let invoked = false;
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        codex: { available: true, queueDepth: 0 },
      }),
    adapter: {
      invoke: async () => {
        invoked = true;
        throw new Error("adapter must not be invoked");
      },
    },
  });

  await assert.rejects(
    () =>
      svc.invokeForWorker({
        taskRunId: taskRun.id,
        profile,
        stepId: "step-codex-worker-policy",
        userRequest: "use repo mcp",
      }),
    (err) =>
      err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE" &&
      /Codex provider cannot enforce AgentProfile tool policy/.test(err.message),
  );
  assert.equal(invoked, false);
});

test("invokeForWorker asks for harness plan output and returns parsed actions", async () => {
  const taskRun = {
    id: "tr-worker",
    threadId: "th-worker",
    userRequest: "original request",
    targetDir: "/tmp/project",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = {
    id: "ap-worker",
    name: "Worker",
    description: "",
    provider: "codex",
    role: "coder",
    persona: "Be precise.",
    tuning: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const invocation = {
    id: "inv-worker",
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let lastRequest = null;
  let createAgentInvocationInput = null;
  let workerCapabilityContextInput = null;
  const workerUsagePatches = [];
  let artifactSeq = 0;
  const artifacts = [];
  const rawProviderOutput =
    '{"type":"item.completed","item":{"type":"assistant_message","role":"assistant","content":[{"type":"output_text","text":"worker raw stream answer"}]}}\n';
  const planOutput = {
    summary: "Create file",
    assumptions: [],
    steps: [{ title: "Write file", rationale: "requested", risk: "medium" }],
    proposedActions: [
      {
        type: "file_write",
        path: "created.txt",
        after: "created\n",
        rationale: "create requested file",
      },
    ],
    suggestedQualityChecks: [],
    questions: [],
  };
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      getThread: async () => ({
        id: "th-worker",
        title: "t",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => {
        const artifact = {
          id: `art-${++artifactSeq}`,
          taskRunId: input.taskRunId,
          stepId: input.stepId,
          kind: input.kind,
          title: input.title,
          uri: input.uri,
          summary: input.summary,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        artifacts.push(artifact);
        return artifact;
      },
      createAgentInvocation: async (input) => {
        createAgentInvocationInput = input;
        return { ...invocation, stepId: input.stepId };
      },
      updateAgentInvocation: async (_id, patch) => {
        workerUsagePatches.push(patch);
        return { ...invocation, ...patch };
      },
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    getApprovedCapabilityContexts: async (input) => {
      workerCapabilityContextInput = input;
      return [];
    },
    adapter: {
      invoke: async (request) => {
        lastRequest = request;
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          rawStdout: rawProviderOutput,
          tokenUsage: { inputTokens: 123, outputTokens: 45, cachedInputTokens: 23, reasoningOutputTokens: 5 },
          stderr: "",
          normalizedEvents: [],
          latencyMs: 12,
        };
      },
    },
  });

  const handoffMessages = [
    {
      fromRole: "planner",
      fromTitle: "Plan",
      content: "Planner handoff: inspect the worker prompt path before coding.",
      artifactId: "art_handoff_1",
      createdAt: "2026-05-15T00:00:00.000Z",
    },
  ];
  const result = await svc.invokeForWorker({
    taskRunId: taskRun.id,
    profile,
    stepId: "step-worker",
    userRequest: "create a file",
    handoffMessages,
  });

  assert.equal(result.proposedActions?.length, 1);
  const workerUsage = workerUsagePatches.find((patch) => patch.inputTokens !== undefined);
  assert.equal(workerUsage.inputTokens, 123);
  assert.equal(workerUsage.outputTokens, 45);
  assert.equal(workerUsage.totalTokens, 168);
  assert.equal(workerUsage.usageApproximate, false);
  assert.deepEqual(workerCapabilityContextInput, {
    taskRunId: taskRun.id,
    profileId: profile.id,
  });
  assert.equal(createAgentInvocationInput?.stepId, "step-worker");
  assert.equal(createAgentInvocationInput?.profileId, profile.id);
  assert.equal(result.proposedActions?.[0].type, "file_write");
  assert.equal(result.proposedActions?.[0].path, "created.txt");
  assert.match(lastRequest.systemPrompt, /OUTPUT CONTRACT/);
  assert.match(lastRequest.systemPrompt, /Do NOT modify files directly/);
  assert.match(lastRequest.prompt, /targetDir: \/tmp\/project/);
  assert.match(lastRequest.prompt, /create a file/);
  assert.match(lastRequest.prompt, /INTERNAL AGENT HANDOFF/);
  assert.match(lastRequest.prompt, /planner: Plan/);
  assert.match(lastRequest.prompt, /Planner handoff: inspect the worker prompt path before coding/);
  const promptArtifact = artifacts.find(
    (artifact) => artifact.title === "Worker prompt — Worker",
  );
  assert.match(promptArtifact?.summary ?? "", /INTERNAL AGENT HANDOFF/);
  assert.match(promptArtifact?.summary ?? "", /art_handoff_1/);
  const persisted = parseJsonLines(
    artifacts.find((artifact) => artifact.title === "Worker raw output — Worker")
      ?.summary ?? "",
  );
  assert.ok(
    persisted.some(
      (event) => event.type === "raw" && event.text === rawProviderOutput,
    ),
  );
  assert.ok(
    persisted.some(
      (event) =>
        event.type === "assistant_text" && event.text.includes("created.txt"),
    ),
  );
  assert.ok(persisted.some((event) => event.type === "result"));
});

test("invokeForWorker prefers modelInvoker over legacy adapter", async () => {
  const taskRun = {
    id: "tr-worker-invoker",
    threadId: "th-worker-invoker",
    userRequest: "original request",
    targetDir: "/tmp/project",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = workerProfile({
    id: "ap-worker-invoker",
    name: "Invoker Worker",
    provider: "codex",
  });
  const invocation = {
    id: "inv-worker-invoker",
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const planOutput = {
    summary: "Use invoker " + "x".repeat(210_000),
    assumptions: [],
    steps: [{ title: "Answer", rationale: "test", risk: "low" }],
    proposedActions: [{ type: "file_write", path: "example.txt", after: "const token=private_value", rationale: "test redaction" }],
    suggestedQualityChecks: [],
    questions: [],
  };
  let artifactSeq = 0;
  let invokerCalled = false;
  let legacyAdapterCalled = false;
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      getThread: async () => ({
        id: taskRun.threadId,
        title: "thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createArtifact: async (input) => ({
        id: `art-${++artifactSeq}`,
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createAgentInvocation: async (input) => ({
        ...invocation,
        stepId: input.stepId,
        promptArtifactId: input.promptArtifactId,
      }),
      updateAgentInvocation: async (_id, patch) => ({ ...invocation, ...patch }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    modelInvoker: {
      invoke: async (request, onEvent, signal) => {
        invokerCalled = true;
        assert.equal(signal instanceof AbortSignal, true);
        onEvent({
          type: "tool_call",
          invocationId: request.invocationId,
          taskRunId: request.taskRunId,
          provider: request.modelConfig.provider,
          source: "stdout",
          phase: "started",
          toolName: "Read",
          toolCallId: "tool-1",
          input: { file_path: "README.md" },
        });
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: `\`\`\`harness_agent_plan\n${JSON.stringify(planOutput)}\n\`\`\``,
          rawStdout: "raw output",
          stderr: "",
          normalizedEvents: [],
          latencyMs: 12,
        };
      },
    },
    adapter: {
      invoke: async () => {
        legacyAdapterCalled = true;
        throw new Error("legacy adapter must not run when modelInvoker is set");
      },
    },
  });

  const result = await svc.invokeForWorker({
    taskRunId: taskRun.id,
    profile,
    stepId: "step-worker-invoker",
    userRequest: "answer only",
  });

  assert.equal(invokerCalled, true);
  assert.equal(legacyAdapterCalled, false);
  assert.equal(result.proposedActions[0].after, "const token=private_value");
});

test("invokeForWorker runs same-provider workers on independent lanes", async () => {
  const taskRun = {
    id: "tr-parallel-workers",
    threadId: "th-parallel-workers",
    userRequest: "original request",
    targetDir: "/tmp/project",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const profile = workerProfile({
    id: "ap-parallel-worker",
    name: "Parallel Worker",
    provider: "codex",
    tuning: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
  });
  const gate = deferred();
  const starts = [];
  const requests = [];
  let artifactSeq = 0;
  let invocationSeq = 0;
  const svc = new AgentPlanningService({
    workspaceChangeTracker: null,
    state: makeGateway({
      getTaskRun: async () => taskRun,
      getThread: async () => ({
        id: taskRun.threadId,
        title: "thread",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      getSettings: async () => ({
        agent: {
          provider: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
          codexWorkspaceWrite: true,
          codexAutoReview: true,
        },
        orchestration: {
          enabled: false,
          defaultMode: "single_worker",
          defaultInstructions: "",
          workerProfiles: [],
        },
        approval: { autoApprove: false },
      }),
      createArtifact: async (input) => ({
        id: `art-${++artifactSeq}`,
        taskRunId: input.taskRunId,
        stepId: input.stepId,
        kind: input.kind,
        title: input.title,
        uri: input.uri,
        summary: input.summary,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      createAgentInvocation: async (input) => ({
        id: `inv-worker-${++invocationSeq}`,
        taskRunId: input.taskRunId,
        provider: input.provider,
        model: input.model,
        status: "queued",
        promptArtifactId: input.promptArtifactId,
        stepId: input.stepId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      updateAgentInvocation: async (id, patch) => ({
        id,
        taskRunId: taskRun.id,
        provider: "codex",
        model: "gpt-5.6-sol",
        status: patch.status ?? "running",
        promptArtifactId: "art-prompt",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...patch,
      }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ codex: { available: true, queueDepth: 0 } }),
    adapter: {
      invoke: async (request) => {
        starts.push(request.invocationId);
        requests.push(request);
        if (starts.length === 1) await gate.promise;
        return {
          provider: request.modelConfig.provider,
          model: request.modelConfig.model,
          exitCode: 0,
          stdout: "```harness_agent_plan\n" + JSON.stringify({ summary: `worker output from ${request.invocationId}`, assumptions: [], steps: [], proposedActions: [], suggestedQualityChecks: [], questions: [] }) + "\n```",
          stderr: "",
          normalizedEvents: [],
          latencyMs: 10,
        };
      },
    },
  });

  const first = svc.invokeForWorker({
    taskRunId: taskRun.id,
    profile,
    stepId: "step-worker-1",
    userRequest: "worker one",
  });
  const second = svc.invokeForWorker({
    taskRunId: taskRun.id,
    profile,
    stepId: "step-worker-2",
    userRequest: "worker two",
  });

  for (let i = 0; i < 32 && starts.length < 2; i += 1) {
    await Promise.resolve();
  }
  assert.equal(starts.length, 2, "same-provider workers should start together");
  assert.equal(requests.some((request) => request.sessionId !== undefined), false);
  assert.equal(
    requests.every((request) => request.modelConfig.reasoningEffort === "high"),
    true,
  );
  assert.equal(
    requests.every((request) => request.sandbox.mode === "workspace-write"),
    true,
  );
  assert.equal(
    requests.every((request) => request.sandbox.autoReview === true),
    true,
  );
  assert.equal(
    requests.every((request) =>
      /workspace-write sandbox/.test(request.systemPrompt),
    ),
    true,
  );

  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.match(firstResult.outputText, /worker output/);
  assert.match(secondResult.outputText, /worker output/);
});
