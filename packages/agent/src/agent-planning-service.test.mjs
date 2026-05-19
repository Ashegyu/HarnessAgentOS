import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
} from "@harness/core";
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

test("getQueueDepths reports empty provider queues for idle service", () => {
  const svc = new AgentPlanningService({
    state: makeGateway(),
    getProviderStatus: () => null,
  });
  assert.deepEqual(svc.getQueueDepths(), {
    claude: 0,
    codex: 0,
    total: 0,
  });
});

const workerProfile = (overrides = {}) => ({
  id: "ap-worker",
  name: "Worker",
  description: "",
  provider: "claude",
  role: "coder",
  persona: "Be precise.",
  tuning: {
    model: "claude-sonnet-4-6",
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

const codexProfile = (overrides = {}) => {
  const base = workerProfile({
    provider: "codex",
    tuning: {
      model: "gpt-5.5",
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
    getProviderStatus: () => ({ claude: { available: false }, codex: { available: false } }),
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
    provider: "claude",
    model: "claude-opus-4-5",
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
      /** @type {any} */ ({ claude: { available: true, queueDepth: 0 } }),
    adapter: {
      invoke: async () => {
        throw new Error("spawn failed with api_key=super-secret-value");
      },
    },
    defaults: { timeoutMs: 100, stallTimeoutMs: 50 },
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: "tr-cli-fail", provider: "claude" }),
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
    provider: "claude",
    model: "claude-opus-4-5",
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
  let capabilityContextInput = null;
  const activeProfile = {
    id: "ap-progress",
    name: "LocalPlanner",
    description: "",
    provider: "claude",
    role: "planner",
    persona: "Plan precisely.",
    tuning: {
      model: "claude-opus-4-5",
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
      toolAllowlist: ["Read", "mcp__repo__search"],
      toolDenylist: ["Bash(git *)"],
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
      createAgentInvocation: async () => baseInvocation,
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
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ claude: { available: true, queueDepth: 0 } }),
    getApprovedCapabilityContexts: async (input) => {
      capabilityContextInput = input;
      return [];
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

  await svc.generatePlan({ taskRunId: "tr-progress", provider: "claude" });

  assert.deepEqual(capabilityContextInput, {
    taskRunId: "tr-progress",
    profileId: activeProfile.id,
  });
  assert.deepEqual(lastRequest.toolPolicy, {
    toolAllowlist: ["Read", "mcp__repo__search"],
    toolDenylist: [
      "Bash",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "Task",
      "Bash(git *)",
    ],
  });
  assert.equal(adapterSignal instanceof AbortSignal, true);
  assert.equal(
    createStepInputs[0]?.title,
    "Agent[LocalPlanner] plan (claude:claude-opus-4-5)",
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
    model: "gpt-5.5",
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
        claude: { available: false, queueDepth: 0 },
        codex: { available: true, queueDepth: 0 },
      }),
    getApprovedLearnerModel: async () => ({
      model: "gpt-5.5",
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
  assert.equal(result.invocation.model, "gpt-5.5");
  assert.equal(lastRequest.modelConfig.provider, "codex");
  assert.equal(lastRequest.modelConfig.model, "gpt-5.5");
  assert.deepEqual(selections, [
    { taskRunId: "tr-learner-model", selectedModel: "gpt-5.5" },
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
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        claude: { available: false, queueDepth: 0 },
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

test("generatePlan rejects Codex profiles with MCP bindings", async () => {
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
    mcpServerIds: ["mcp_repo"],
  });
  const svc = new AgentPlanningService({
    state: makeGateway({
      getTaskRun: async () => taskRun,
      listAgentProfiles: async () => [profile],
      getSettings: async () => ({
        activeAgentProfileId: profile.id,
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
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({
        claude: { available: false, queueDepth: 0 },
        codex: { available: true, queueDepth: 0 },
      }),
  });

  await assert.rejects(
    () => svc.generatePlan({ taskRunId: taskRun.id, provider: "codex" }),
    (err) =>
      err.constructor.name === "AgentPlanningError" &&
      err.code === "AGENT_PROVIDER_UNAVAILABLE" &&
      /Codex provider cannot enforce AgentProfile MCP bindings/.test(
        err.message,
      ),
  );
});

test("invokeForWorker rejects Codex profiles with unsupported MCP or tool policy", async () => {
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
    mcpServerIds: ["mcp_repo"],
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
      /Codex provider cannot enforce AgentProfile MCP bindings and tool policy/.test(
        err.message,
      ),
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
    provider: "claude",
    role: "coder",
    persona: "Be precise.",
    tuning: {
      model: "claude-sonnet-4-6",
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
      toolAllowlist: ["Read", "mcp__repo__search"],
      toolDenylist: ["Bash(git *)"],
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
    provider: "claude",
    model: "claude-sonnet-4-6",
    status: "queued",
    promptArtifactId: "art-prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let lastRequest = null;
  let createAgentInvocationInput = null;
  let workerCapabilityContextInput = null;
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
      updateAgentInvocation: async (_id, patch) => ({ ...invocation, ...patch }),
    }),
    getProviderStatus: () =>
      /** @type {any} */ ({ claude: { available: true, queueDepth: 0 } }),
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
  assert.deepEqual(workerCapabilityContextInput, {
    taskRunId: taskRun.id,
    profileId: profile.id,
  });
  assert.equal(createAgentInvocationInput?.stepId, "step-worker");
  assert.equal(result.proposedActions?.[0].type, "file_write");
  assert.equal(result.proposedActions?.[0].path, "created.txt");
  assert.match(lastRequest.systemPrompt, /OUTPUT CONTRACT/);
  assert.deepEqual(lastRequest.toolPolicy, {
    toolAllowlist: ["Read", "mcp__repo__search"],
    toolDenylist: [
      "Bash",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
      "Task",
      "Bash(git *)",
    ],
  });
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
      model: "gpt-5.5",
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
    state: makeGateway({
      getTaskRun: async () => taskRun,
      getThread: async () => ({
        id: taskRun.threadId,
        title: "thread",
        agentSessionId: "shared-claude-session",
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
        model: "gpt-5.5",
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
          stdout: `worker output from ${request.invocationId}`,
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

  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.equal(starts.length, 2, "same-provider workers should start together");
  assert.equal(requests.some((request) => request.sessionId !== undefined), false);

  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.match(firstResult.outputText, /worker output/);
  assert.match(secondResult.outputText, /worker output/);
});
