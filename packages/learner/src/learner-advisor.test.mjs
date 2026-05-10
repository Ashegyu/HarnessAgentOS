import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { LearnerAdvisor } from "./learner-advisor.ts";
import { TraceRecorder } from "./trace-recorder.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-advisor-"));
  return {
    dir,
    file: join(dir, "test.db"),
    decisionsDir: join(dir, "decisions"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state, request = "refactor and rename helper") => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: request,
    targetDir: "/tmp/proj",
    status: "running",
  });
};

test("recommend returns conservative fallback with no history", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const rec = await advisor.recommend({ taskRunId: taskRun.id });
    assert.deepEqual(rec.recommendedCapabilities, []);
    assert.match(rec.rationale, /No prior trace history/i);
    assert.ok(rec.confidence < 0.5);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend ranks capabilities by trigger overlap and trace history", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    await state.upsertCapability({
      id: "cap_refactor",
      source: "skillify:test",
      name: "refactor",
      description: "r",
      triggerTerms: ["refactor", "rename"],
      riskLevel: "low",
      requiresApproval: false,
    });
    await state.upsertCapability({
      id: "cap_build",
      source: "skillify:test",
      name: "build",
      description: "b",
      triggerTerms: ["build"],
      riskLevel: "low",
      requiresApproval: false,
    });
    // Seed a successful prior trace that used the refactor capability.
    const recorder = new TraceRecorder({ state });
    const oldTaskRun = await seedTaskRun(state, "refactor previously");
    await recorder.recordSelection({
      taskRunId: oldTaskRun.id,
      selectedModel: "claude-sonnet-4-6",
      selectedCapabilities: ["cap_refactor"],
    });
    await recorder.recordOutcome({
      taskRunId: oldTaskRun.id,
      qualityGate: {
        id: "qg_1",
        taskRunId: oldTaskRun.id,
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: "2024-01-01T00:00:00Z",
      },
      latencyMs: 4_000,
      costEstimate: 0.02,
      success: true,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const rec = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec.recommendedCapabilities.length >= 1);
    assert.equal(rec.recommendedCapabilities[0].capability.id, "cap_refactor");
    assert.equal(rec.recommendedModel, "claude-sonnet-4-6");
    assert.equal(rec.costHint, "low");
    assert.equal(rec.latencyHint, "low");
    assert.ok(rec.confidence > 0.2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordDecision appends to decisions.jsonl", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    await advisor.recordDecision({
      taskRunId: "tsk_test",
      recommendationId: "rec_1",
      decision: "rejected",
      reason: "too expensive",
    });
    const file = join(t.decisionsDir, "decisions.jsonl");
    assert.ok(existsSync(file));
    const content = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.taskRunId, "tsk_test");
    assert.equal(parsed.decision, "rejected");
    assert.equal(parsed.reason, "too expensive");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordDecision redacts secrets and caps reason length", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const longTail = "x".repeat(500);
    await advisor.recordDecision({
      taskRunId: "tsk_test",
      recommendationId: "rec_1",
      decision: "rejected",
      reason: `leaked api_key=sk-abcdef123 and ghp_${"A".repeat(30)} ${longTail}`,
    });
    const file = join(t.decisionsDir, "decisions.jsonl");
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    assert.ok(!/sk-abcdef123/.test(parsed.reason));
    assert.ok(!/ghp_AAA/.test(parsed.reason));
    assert.match(parsed.reason, /\[REDACTED\]/);
    assert.ok(parsed.reason.length <= 240);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
