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
import { TraceRecorder } from "./trace-recorder.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-trace-"));
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
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "do",
    targetDir: "/tmp/proj",
    status: "running",
  });
};

test("ensureTrace returns existing trace and is idempotent", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const recorder = new TraceRecorder({ state });
    const a = await recorder.ensureTrace(taskRun.id);
    const b = await recorder.ensureTrace(taskRun.id);
    assert.equal(a.id, b.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordSelection stores selectedModel and capabilities", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const recorder = new TraceRecorder({ state });
    const trace = await recorder.recordSelection({
      taskRunId: taskRun.id,
      selectedModel: "claude-sonnet-4-6",
      selectedCapabilities: ["cap_1", "cap_2"],
    });
    assert.equal(trace.selectedModel, "claude-sonnet-4-6");
    assert.deepEqual(trace.selectedCapabilities, ["cap_1", "cap_2"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordOutcome computes reward and redacts secrets in failureReason", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const recorder = new TraceRecorder({ state });
    const trace = await recorder.recordOutcome({
      taskRunId: taskRun.id,
      qualityGate: {
        id: "qg_1",
        taskRunId: taskRun.id,
        status: "failed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: "2024-01-01T00:00:00Z",
      },
      success: false,
      failureReason:
        "ghp_abcdefghijklmnopqrst leaked while running deploy script",
    });
    assert.equal(trace.success, false);
    assert.equal(trace.reward, -0.5);
    assert.match(trace.failureReason, /\[REDACTED\]/);
    assert.doesNotMatch(trace.failureReason, /ghp_abc/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
