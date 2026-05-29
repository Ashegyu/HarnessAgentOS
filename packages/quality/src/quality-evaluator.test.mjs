import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { TaskRunCompletionService } from "../../../packages/core/src/index.ts";
import { QualityEvaluator } from "./quality-evaluator.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-quality-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state) => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "do something",
    targetDir: "/tmp/proj",
    status: "running",
  });
  return taskRun;
};

test("evaluate persists row and reports not_run when nothing required and no evidence", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const evaluator = new QualityEvaluator({ state });
    const result = await evaluator.evaluate({ taskRunId: taskRun.id });
    assert.equal(result.status, "not_run");
    const latest = await state.getLatestQualityGateResult(taskRun.id);
    assert.ok(latest);
    assert.equal(latest.id, result.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("evaluate marks failed when test step failed and reflects status via completion service", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "failed");

    const evaluator = new QualityEvaluator({ state });
    const completion = new TaskRunCompletionService({ state });
    const result = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.testsPassed, false);

    const updated = await completion.applyQualityGateResult(result);
    assert.equal(updated.status, "quality_failed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("evaluate + completion promotes to ready_for_review when passed", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "succeeded");

    const evaluator = new QualityEvaluator({ state });
    const completion = new TaskRunCompletionService({ state });
    const result = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    assert.equal(result.status, "passed");
    assert.equal(result.testsPassed, true);

    const updated = await completion.applyQualityGateResult(result);
    assert.equal(updated.status, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("evaluate requires dedicated smoke evidence when requireSmoke is true", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "succeeded");

    const evaluator = new QualityEvaluator({ state });
    const result = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireSmoke: true,
    });
    assert.equal(result.status, "warning");
    assert.equal(result.testsPassed, true);
    assert.equal(result.smokePassed, undefined);
    assert.ok(result.knownRisks.includes("smoke evidence is missing"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("evaluate marks passing smoke evidence independently from unit tests", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const smokeStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "shell",
      title: "npm run smoke",
      status: "running",
    });
    await state.setStepStatus(smokeStep.id, "succeeded");

    const evaluator = new QualityEvaluator({ state });
    const result = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireSmoke: true,
    });
    assert.equal(result.status, "passed");
    assert.equal(result.testsPassed, undefined);
    assert.equal(result.smokePassed, true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("evaluate fails when smoke evidence failed", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const smokeStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "shell",
      title: "playwright smoke",
      status: "running",
    });
    await state.setStepStatus(smokeStep.id, "failed");

    const evaluator = new QualityEvaluator({ state });
    const result = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireSmoke: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.smokePassed, false);
    assert.ok(result.knownRisks.includes("smoke failed in this run"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("markDone is blocked when latest gate is not passed", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    // Insert a warning gate manually
    const evaluator = new QualityEvaluator({ state });
    const completion = new TaskRunCompletionService({ state });
    // Add a diff artifact to produce a "files changed but no tests" risk → warning.
    const artStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "edit",
      title: "edit",
      status: "succeeded",
    });
    await state.createArtifact({
      taskRunId: taskRun.id,
      stepId: artStep.id,
      kind: "diff",
      title: "diff",
      uri: "artifact://d/1",
    });
    const result = await evaluator.evaluate({ taskRunId: taskRun.id });
    assert.equal(result.status, "warning");
    await completion.applyQualityGateResult(result);

    await assert.rejects(
      () => completion.markDone({ taskRunId: taskRun.id }),
      (e) => e.code === "QUALITY_DONE_BLOCKED",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("approveKnownRisks requires non-empty message", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const evaluator = new QualityEvaluator({ state });
    const completion = new TaskRunCompletionService({ state });

    const artStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "edit",
      title: "edit",
      status: "succeeded",
    });
    await state.createArtifact({
      taskRunId: taskRun.id,
      stepId: artStep.id,
      kind: "diff",
      title: "diff",
      uri: "artifact://d/1",
    });
    const result = await evaluator.evaluate({ taskRunId: taskRun.id });
    assert.equal(result.status, "warning");

    await assert.rejects(
      () => completion.approveKnownRisks({
        taskRunId: taskRun.id,
        message: "  ",
      }),
      (e) => e.code === "QUALITY_RISK_MESSAGE_REQUIRED",
    );

    const updated = await completion.approveKnownRisks({
      taskRunId: taskRun.id,
      message: "Documentation-only change; manual review done",
    });
    assert.equal(updated.status, "ready_for_review");

    // Quality report artifact should exist now.
    const artifacts = await state.listArtifactsByTaskRun(taskRun.id);
    assert.ok(artifacts.some((a) => a.kind === "quality_report"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createRepairPlan returns a draft when gate is failed", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const failingTest = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(failingTest.id, "failed");

    const evaluator = new QualityEvaluator({ state });
    const completion = new TaskRunCompletionService({ state });
    const gate = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    assert.equal(gate.status, "failed");
    await completion.applyQualityGateResult(gate);

    const draft = await completion.createRepairPlan({
      taskRunId: taskRun.id,
      instruction: "fix the broken test",
    });
    assert.equal(draft.taskRun.status, "waiting_for_approval");
    assert.equal(draft.checkpoint.reason, "before_edit");
    assert.equal(draft.planArtifact.kind, "plan");
    assert.ok(draft.approvals.length === 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("renderer cannot reach done without passing gate (end-to-end via service)", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const completion = new TaskRunCompletionService({ state });

    // Without any gate, markDone should be blocked.
    await assert.rejects(
      () => completion.markDone({ taskRunId: taskRun.id }),
      (e) => e.code === "QUALITY_DONE_BLOCKED",
    );

    // Direct setTaskRunStatus is allowed at the storage layer (the gate is
    // enforced by the renderer-facing service), but a passing gate must
    // exist before markDone succeeds.
    await state.setTaskRunStatus(taskRun.id, "ready_for_review");
    await assert.rejects(
      () => completion.markDone({ taskRunId: taskRun.id }),
      (e) => e.code === "QUALITY_DONE_BLOCKED",
    );

    // Add passing test evidence and re-evaluate; markDone should now succeed.
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "succeeded");
    const evaluator = new QualityEvaluator({ state });
    const gate = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    assert.equal(gate.status, "passed");
    await state.setTaskRunStatus(taskRun.id, "running");
    await assert.rejects(
      () => completion.markDone({ taskRunId: taskRun.id }),
      (e) =>
        e.code === "QUALITY_DONE_BLOCKED" &&
        /current: running/.test(e.message),
    );
    await completion.applyQualityGateResult(gate);
    const done = await completion.markDone({ taskRunId: taskRun.id });
    assert.equal(done.status, "done");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("markDone fires onTaskRunDone before flipping status", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const seen = [];
    const completion = new TaskRunCompletionService({
      state,
      onTaskRunDone: async (id) => {
        const tr = await state.getTaskRun(id);
        seen.push({ id, statusBefore: tr.status });
      },
    });
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "succeeded");
    const evaluator = new QualityEvaluator({ state });
    const gate = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    await completion.applyQualityGateResult(gate);
    const done = await completion.markDone({ taskRunId: taskRun.id });
    assert.equal(done.status, "done");
    // Hook fired exactly once, before the row flipped to done.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, taskRun.id);
    assert.equal(seen[0].statusBefore, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("markDone fails atomically when onTaskRunDone throws", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const completion = new TaskRunCompletionService({
      state,
      onTaskRunDone: async () => {
        throw new Error("trace recorder offline");
      },
    });
    const testStep = await state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "test",
      title: "vitest",
      status: "running",
    });
    await state.setStepStatus(testStep.id, "succeeded");
    const evaluator = new QualityEvaluator({ state });
    const gate = await evaluator.evaluate({
      taskRunId: taskRun.id,
      requireTests: true,
    });
    await completion.applyQualityGateResult(gate);
    await assert.rejects(
      () => completion.markDone({ taskRunId: taskRun.id }),
      /trace recorder offline/,
    );
    const tr = await state.getTaskRun(taskRun.id);
    assert.equal(tr.status, "ready_for_review");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
