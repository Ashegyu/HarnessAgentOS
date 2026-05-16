import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-repair-attempt-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRunAndGate = async (state) => {
  const thread = await state.createThread({ title: "repair" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "fix failing tests",
    targetDir: process.cwd(),
  });
  await state.createQualityGateResult({
    id: "qg-1",
    taskRunId: taskRun.id,
    status: "failed",
    testsPassed: false,
    knownRisks: ["tests failed"],
    evidenceArtifactIds: ["art-log"],
    createdAt: "2026-05-16T00:00:00.000Z",
  });
  return { taskRun };
};

test("RepairAttemptRepository creates indexed attempts and updates approval ids", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRunAndGate(state);
    const first = await state.repairAttempts.create({
      taskRunId: taskRun.id,
      qualityGateId: "qg-1",
      failureSignature: "sig-1",
    });
    const second = await state.repairAttempts.create({
      taskRunId: taskRun.id,
      qualityGateId: "qg-1",
      failureSignature: "sig-2",
    });
    const prompt = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "prompt",
      uri: "harness:test-prompt",
      summary: "prompt",
    });
    const invocation = await state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider: "codex",
      model: "gpt-test",
      promptArtifactId: prompt.id,
    });
    assert.equal(first.attemptIndex, 0);
    assert.equal(second.attemptIndex, 1);
    const updated = await state.repairAttempts.update(first.id, {
      status: "waiting_for_approval",
      invocationId: invocation.id,
      generatedApprovalIds: ["apv-1", "apv-2"],
    });
    assert.equal(updated.status, "waiting_for_approval");
    assert.deepEqual(updated.generatedApprovalIds, ["apv-1", "apv-2"]);
    const rows = await state.repairAttempts.listByTaskRun(taskRun.id);
    assert.equal(rows.length, 2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
