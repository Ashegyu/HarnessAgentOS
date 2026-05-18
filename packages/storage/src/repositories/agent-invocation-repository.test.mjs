import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-agent-invocation-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const createInvocation = async (state, targetDir, latencyMs, finishedAt) => {
  const thread = await state.createThread({ title: "Thread", targetDir });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "Run agent",
    targetDir,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "plan",
    title: "Agent prompt",
    uri: `harness:test/${taskRun.id}/prompt`,
    summary: "prompt",
  });
  const invocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: "gpt-5",
    promptArtifactId: prompt.id,
  });
  if (latencyMs !== null) {
    await state.updateAgentInvocation(invocation.id, {
      status: "succeeded",
      startedAt: "2026-05-18T00:00:00.000Z",
      finishedAt,
      latencyMs,
    });
  }
  return invocation;
};

test("AgentInvocationRepository.listRecentWithLatency returns newest latency rows only", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const first = await createInvocation(
      state,
      t.dir,
      1200,
      "2026-05-18T00:01:00.000Z",
    );
    const second = await createInvocation(
      state,
      t.dir,
      800,
      "2026-05-18T00:02:00.000Z",
    );
    await createInvocation(state, t.dir, null, "2026-05-18T00:03:00.000Z");

    const recent = await state.agentInvocations.listRecentWithLatency(2);

    assert.deepEqual(
      recent.map((invocation) => invocation.id),
      [second.id, first.id],
    );
    assert.deepEqual(
      recent.map((invocation) => invocation.latencyMs),
      [800, 1200],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
