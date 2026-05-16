import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2AWorkerInvoker } from "@harness/agent";
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

const validProfileInput = (overrides = {}) => ({
  name: "RemoteReviewerProfile",
  description: "",
  category: "test",
  tags: ["reviewer"],
  provider: "codex",
  role: "reviewer",
  persona: "Review via remote A2A worker.",
  tuning: {
    model: "gpt-5.5",
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
    assert.match(workerArtifact?.summary ?? "", /requires user input/i);
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
