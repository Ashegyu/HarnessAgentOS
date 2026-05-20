import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-a2a-refinement-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTarget = async (state) => {
  const thread = await state.createThread({ title: "a2a refinement" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "review remote output",
    targetDir: process.cwd(),
  });
  const endpoint = await state.a2aRemoteAgents.upsertEndpoint({
    name: "Remote Planner",
    baseUrl: "https://agents.example.com/planner",
    agentCardUrl: "https://agents.example.com/planner/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: true,
    trusted: true,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: "prompt",
    uri: "harness:test-prompt",
    summary: "prompt",
  });
  const evidence = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "quality_report",
    title: "review evidence",
    uri: "harness:test-evidence",
    summary: "missing acceptance criteria",
  });
  const invocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: "a2a-remote",
    promptArtifactId: prompt.id,
  });
  await state.a2aRemoteAgents.upsertRemoteTaskRef({
    invocationId: invocation.id,
    endpointId: endpoint.id,
    remoteTaskId: "remote-task-1",
    remoteContextId: "remote-context-1",
    state: "completed",
    lastEventAt: "2026-05-20T00:00:00.000Z",
  });
  return { taskRun, endpoint, invocation, evidence };
};

test("A2ARefinementAttemptRepository creates and updates attempt ledger rows", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);

    const attempt = await state.a2aRefinements.create({
      taskRunId: taskRun.id,
      targetInvocationId: invocation.id,
      endpointId: endpoint.id,
      feedbackSourceKind: "worker",
      feedbackSourceInvocationId: invocation.id,
      feedbackArtifactId: evidence.id,
      parentRemoteTaskId: "remote-task-1",
      parentRemoteContextId: "remote-context-1",
      referenceTaskIds: ["remote-task-1"],
      referenceArtifactIds: [evidence.id],
      feedbackSignature: "sig-1",
    });

    assert.equal(attempt.status, "pending_approval");
    assert.equal(attempt.attemptIndex, 0);
    assert.deepEqual(attempt.referenceTaskIds, ["remote-task-1"]);
    assert.deepEqual(attempt.referenceArtifactIds, [evidence.id]);

    const updated = await state.a2aRefinements.update(attempt.id, {
      status: "succeeded",
      remoteTaskId: "remote-task-2",
      remoteContextId: "remote-context-1",
      completedAt: "2026-05-20T01:00:00.000Z",
    });
    assert.equal(updated.status, "succeeded");
    assert.equal(updated.remoteTaskId, "remote-task-2");
    assert.equal(updated.completedAt, "2026-05-20T01:00:00.000Z");

    const byTaskRun = await state.a2aRefinements.listByTaskRun(taskRun.id);
    assert.deepEqual(byTaskRun.map((row) => row.id), [attempt.id]);
    const byTarget = await state.a2aRefinements.listByTargetInvocation(
      invocation.id,
    );
    assert.deepEqual(byTarget.map((row) => row.id), [attempt.id]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARefinementAttemptRepository rejects duplicate active signatures", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);
    const input = {
      taskRunId: taskRun.id,
      targetInvocationId: invocation.id,
      endpointId: endpoint.id,
      feedbackSourceKind: "user",
      feedbackArtifactId: evidence.id,
      referenceTaskIds: ["remote-task-1"],
      referenceArtifactIds: [evidence.id],
      feedbackSignature: "same-signature",
    };

    await state.a2aRefinements.create(input);
    await assert.rejects(
      () => state.a2aRefinements.create(input),
      /active A2A refinement/i,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("A2ARefinementAttemptRepository records dedicated activity events", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, endpoint, invocation, evidence } = await seedTarget(state);
    const attempt = await state.a2aRefinements.create({
      taskRunId: taskRun.id,
      targetInvocationId: invocation.id,
      endpointId: endpoint.id,
      feedbackSourceKind: "quality_gate",
      feedbackArtifactId: evidence.id,
      parentRemoteTaskId: "remote-task-1",
      parentRemoteContextId: "remote-context-1",
      referenceTaskIds: ["remote-task-1"],
      referenceArtifactIds: [evidence.id],
      feedbackSignature: "sig-event",
    });

    await state.a2aRefinements.createEvent({
      taskRunId: taskRun.id,
      attemptId: attempt.id,
      eventType: "created",
      status: attempt.status,
      summary: "A2A refinement approval requested",
      payload: { approvalId: "appr_1" },
    });

    const page = await state.a2aRefinements.listActivityEvents({
      limit: 25,
      offset: 0,
    });

    assert.equal(page.total, 1);
    assert.equal(page.items[0].eventType, "created");
    assert.equal(page.items[0].endpointId, endpoint.id);
    assert.equal(page.items[0].parentRemoteContextId, "remote-context-1");
    assert.deepEqual(page.items[0].payload, { approvalId: "appr_1" });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
