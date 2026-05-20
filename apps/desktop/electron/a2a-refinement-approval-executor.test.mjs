import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { requestA2ARefinement } from "./a2a-refinement-request.ts";
import { executeA2ARefinementApproval } from "./a2a-refinement-approval-executor.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-refinement-exec-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTarget = async (state) => {
  const thread = await state.createThread({ title: "execute refinement" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "execute approved refinement",
    targetDir: process.cwd(),
  });
  const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
    name: "Remote Reviewer",
    baseUrl: "https://agents.example.com/reviewer",
    agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: true,
    trusted: true,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "original prompt",
    uri: "harness:test-original-prompt",
    summary: "original prompt",
  });
  const evidence = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "quality_report",
    title: "review finding",
    uri: "harness:test-review-finding",
    summary: "The previous answer needs acceptance criteria.",
  });
  const invocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: `a2a:${endpoint.id}`,
    promptArtifactId: prompt.id,
  });
  await state.a2aRemoteAgents.upsertRemoteTaskRef({
    invocationId: invocation.id,
    endpointId: endpoint.id,
    remoteTaskId: "remote-task-original",
    remoteContextId: "remote-context-original",
    state: "completed",
  });
  return { taskRun, endpoint, invocation, evidence };
};

test("executeA2ARefinementApproval runs only approved refinement network approvals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);
    const request = await requestA2ARefinement({
      state,
      input: {
        taskRunId: taskRun.id,
        targetInvocationId: invocation.id,
        instruction: "Please add the missing acceptance criteria.",
        referencedArtifactIds: [evidence.id],
        feedbackSourceKind: "user",
        feedbackArtifactId: evidence.id,
      },
    });
    await state.decideApproval(request.approval.id, "approved", "ok");

    const requests = [];
    const result = await executeA2ARefinementApproval({
      state,
      approvalId: request.approval.id,
      now: () => "2026-05-20T00:00:00.000Z",
      createArtifactUriNonce: () => "nonce",
      createAdapter: () => ({
        async invoke(input) {
          requests.push(input);
          return {
            outputText: "Refined answer with acceptance criteria.",
            remoteTask: {
              invocationId: input.invocationId,
              endpointId: input.endpointId,
              remoteTaskId: "remote-task-refined",
              remoteContextId: "remote-context-original",
              state: "completed",
              lastEventAt: "2026-05-20T00:00:00.000Z",
            },
            artifacts: [],
            normalizedEvents: [],
            requiresInput: false,
            requiresAuth: false,
          };
        },
      }),
    });

    assert.ok(result);
    assert.equal(result.taskRunId, taskRun.id);
    assert.equal(result.commandSummary, `a2a refinement: ${endpoint.name}`);
    assert.equal(requests[0].message, "Please add the missing acceptance criteria.");
    assert.equal(requests[0].contextId, "remote-context-original");
    assert.deepEqual(requests[0].referenceTaskIds, ["remote-task-original"]);

    const updatedApproval = await state.getApproval(request.approval.id);
    assert.equal(updatedApproval.status, "executed");
    const updatedAttempt = await state.a2aRefinements.get(request.attempt.id);
    assert.equal(updatedAttempt.status, "succeeded");
    assert.equal(updatedAttempt.remoteTaskId, "remote-task-refined");
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "ready_for_review");
    const checkpoint = await state.checkpoints.get(request.approval.checkpointId);
    const step = (await state.listStepsByTaskRun(taskRun.id)).find(
      (candidate) => candidate.id === checkpoint.stepId,
    );
    assert.equal(step.status, "succeeded");
    const events = await state.a2aRefinements.listActivityEvents({
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(
      events.items.map((event) => event.eventType).sort(),
      ["created", "started", "succeeded"],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("executeA2ARefinementApproval records stopped activity when the endpoint becomes unavailable", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);
    const request = await requestA2ARefinement({
      state,
      input: {
        taskRunId: taskRun.id,
        targetInvocationId: invocation.id,
        instruction: "Please retry after endpoint review.",
        referencedArtifactIds: [evidence.id],
        feedbackSourceKind: "user",
        feedbackArtifactId: evidence.id,
      },
    });
    await state.decideApproval(request.approval.id, "approved", "ok");
    await state.a2aRemoteAgents.toggleEndpoint(endpoint.id, false);

    await assert.rejects(
      () =>
        executeA2ARefinementApproval({
          state,
          approvalId: request.approval.id,
          now: () => "2026-05-20T00:00:00.000Z",
        }),
      /A2A remote endpoint unavailable/,
    );

    const events = await state.a2aRefinements.listActivityEvents({
      limit: 10,
      offset: 0,
    });
    const stopped = events.items.find((event) => event.eventType === "stopped");
    assert.ok(stopped);
    assert.equal(stopped.status, "stopped");
    assert.match(stopped.summary, /stopped/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
