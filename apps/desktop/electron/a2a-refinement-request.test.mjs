import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { requestA2ARefinement } from "./a2a-refinement-request.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-refinement-request-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTarget = async (state) => {
  const thread = await state.createThread({ title: "request refinement" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "refine previous remote result",
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
    summary: "The remote result missed acceptance criteria.",
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

test("requestA2ARefinement creates a pending attempt and network approval", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);

    const result = await requestA2ARefinement({
      state,
      input: {
        taskRunId: taskRun.id,
        targetInvocationId: invocation.id,
        instruction: "Ask the remote reviewer to add acceptance criteria.",
        referencedArtifactIds: [evidence.id],
        feedbackSourceKind: "user",
        feedbackArtifactId: evidence.id,
      },
    });

    assert.equal(result.attempt.status, "pending_approval");
    assert.equal(result.attempt.endpointId, endpoint.id);
    assert.equal(result.approval.actionType, "network");
    assert.equal(result.approval.status, "pending");
    const checkpoint = await state.checkpoints.get(result.approval.checkpointId);
    const stateRef = JSON.parse(checkpoint.stateRef);
    assert.equal(stateRef.a2aRefinementAttemptId, result.attempt.id);
    assert.equal(stateRef.targetInvocationId, invocation.id);
    assert.equal(stateRef.endpointId, endpoint.id);
    assert.equal(
      stateRef.instruction,
      "Ask the remote reviewer to add acceptance criteria.",
    );
    const updatedTaskRun = await state.getTaskRun(taskRun.id);
    assert.equal(updatedTaskRun.status, "waiting_for_approval");
    const events = await state.a2aRefinements.listActivityEvents({
      limit: 10,
      offset: 0,
    });
    assert.equal(events.items.length, 1);
    assert.equal(events.items[0].eventType, "created");
    assert.equal(events.items[0].attemptId, result.attempt.id);
    assert.equal(events.items[0].endpointId, endpoint.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
