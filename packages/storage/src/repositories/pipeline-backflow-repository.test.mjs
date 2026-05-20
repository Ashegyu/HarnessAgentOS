import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-pipeline-backflow-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({ title: "backflow" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "run pipeline",
    targetDir: process.cwd(),
  });
  return { thread, taskRun };
};

test("PipelineBackflowRepository creates attempts and activity events", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRun(state);

    const attempt = await state.pipelineBackflows.createAttempt({
      taskRunId: taskRun.id,
      planId: "plan_1",
      ruleId: "bf_fix",
      trigger: "step_failed",
      targetStepId: "worker_plan",
      retryStepId: "worker_code",
      maxAttempts: 2,
      reason: "worker_code failed",
    });

    assert.ok(attempt.id.startsWith("pbf_"));
    assert.equal(attempt.attemptIndex, 0);
    assert.equal(attempt.status, "running");

    await state.pipelineBackflows.createEvent({
      taskRunId: taskRun.id,
      attemptId: attempt.id,
      eventType: "triggered",
      status: "running",
      summary: "Backflow triggered",
      payload: { failedStepId: "worker_code" },
    });
    await state.pipelineBackflows.updateAttempt(attempt.id, {
      status: "succeeded",
      completedAt: "2026-05-20T00:00:00.000Z",
    });

    const attempts = await state.pipelineBackflows.listByTaskRun(taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "succeeded");
    assert.equal(attempts[0].completedAt, "2026-05-20T00:00:00.000Z");

    const page = await state.pipelineBackflows.listActivityEvents({
      limit: 25,
      offset: 0,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].eventType, "triggered");
    assert.equal(page.items[0].ruleId, "bf_fix");
    assert.equal(page.items[0].trigger, "step_failed");
    assert.equal(page.items[0].attemptIndex, 0);
    assert.deepEqual(page.items[0].payload, { failedStepId: "worker_code" });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("PipelineBackflowRepository counts attempts by task, plan, rule, and trigger", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRun(state);
    const input = {
      taskRunId: taskRun.id,
      planId: "plan_1",
      ruleId: "bf_fix",
      trigger: "quality_failed",
      targetStepId: "worker_plan",
      retryStepId: "worker_review",
      maxAttempts: 2,
    };

    await state.pipelineBackflows.createAttempt(input);
    await state.pipelineBackflows.createAttempt(input);

    assert.equal(
      await state.pipelineBackflows.countAttempts({
        taskRunId: taskRun.id,
        planId: "plan_1",
        ruleId: "bf_fix",
        trigger: "quality_failed",
      }),
      2,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
