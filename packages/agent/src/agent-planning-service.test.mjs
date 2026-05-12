import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentPlanningService } from "./agent-planning-service.ts";

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
      provider: "auto",
      model: "",
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

test("cancelInvocation returns immediately if invocation already succeeded", async () => {
  const succeeded = {
    id: "inv-1",
    taskRunId: "tr-1",
    provider: "claude",
    model: "claude-opus-4-5",
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
    provider: "claude",
    model: "claude-opus-4-5",
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
    getProviderStatus: () => /** @type {any} */ ({ claude: { available: true, queueDepth: 0 } }),
    adapter: {
      invoke: async () => { throw { code: "AGENT_CANCELLED", message: "Cancelled by user" }; },
    },
    defaults: { timeoutMs: 100, stallTimeoutMs: 50 },
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-cancel", provider: "claude" }),
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
    // non-null map but claude entry is absent (sparse mock)
    getProviderStatus: () => /** @type {any} */ ({}),
  });
  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-draft", provider: "claude" }),
    (err) => {
      assert.equal(err.constructor.name, "AgentPlanningError",
        `Expected AgentPlanningError but got ${err.constructor.name}: ${err.message}`);
      assert.equal(err.code, "AGENT_PROVIDER_UNAVAILABLE");
      return true;
    },
  );
});
