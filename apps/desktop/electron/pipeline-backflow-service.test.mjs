import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, LocalStateService, openDb } from "@harness/storage";
import { PipelineBackflowService } from "./pipeline-backflow-service.ts";
import { ConversationService } from "@harness/core";
import { createTaskProgressionHost } from "./services/task-progression-host.ts";

const now = "2026-05-20T00:00:00.000Z";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-pipeline-backflow-service-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const validProfileInput = (overrides = {}) => ({
  name: "Coder",
  description: "",
  category: "test",
  tags: ["coder"],
  provider: "codex",
  role: "coder",
  persona: "You are an excellent worker.",
  tuning: {
    model: "gpt-5.6-sol",
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

const seedTaskRun = async (state) => {
  const thread = await state.createThread({ title: "pipeline backflow" });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "quality backflow",
    targetDir: process.cwd(),
    status: "quality_failed",
  });
};

const qualityResult = (taskRunId, status) => ({
  id: `qg_${status}`,
  taskRunId,
  status,
  knownRisks: [],
  evidenceArtifactIds: [],
  createdAt: now,
});

test("PipelineBackflowService ignores passed and warning quality gates", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await seedTaskRun(state);
    let getLatestPlanCalls = 0;
    const service = new PipelineBackflowService({
      state,
      orchestration: {
        async getLatestPlan() {
          getLatestPlanCalls += 1;
          return null;
        },
      },
    });

    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "passed")),
      false,
    );
    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "warning")),
      false,
    );
    assert.equal(getLatestPlanCalls, 0);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "quality_failed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("PipelineBackflowService runs quality_failed backflow and returns ready_for_review", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const taskRun = await seedTaskRun(state);
    const planner = await state.agentProfiles.create(
      validProfileInput({ name: "Planner", role: "planner" }),
    );
    const coder = await state.agentProfiles.create(
      validProfileInput({ name: "Coder", role: "coder" }),
    );
    const tester = await state.agentProfiles.create(
      validProfileInput({ name: "Tester", role: "tester" }),
    );
    const plan = {
      id: "orch_quality_backflow",
      taskRunId: taskRun.id,
      mode: "multi_worker",
      workerSteps: [
        {
          id: "w_plan",
          title: "Plan",
          role: "planner",
          inputSummary: "Plan the repair.",
          instruction: "Plan the repair.",
          expectedArtifactKinds: ["plan"],
          status: "pending",
          agentProfileId: planner.id,
          dependsOn: [],
        },
        {
          id: "w_code",
          title: "Code",
          role: "coder",
          inputSummary: "Apply the repair.",
          instruction: "Apply the repair.",
          expectedArtifactKinds: ["diff"],
          status: "pending",
          agentProfileId: coder.id,
          dependsOn: ["w_plan"],
        },
        {
          id: "w_test",
          title: "Test",
          role: "tester",
          inputSummary: "Verify the repair.",
          instruction: "Verify the repair.",
          expectedArtifactKinds: ["test_result"],
          status: "pending",
          agentProfileId: tester.id,
          dependsOn: ["w_code"],
        },
      ],
      requiresApproval: true,
      backflowRules: [
        {
          id: "bf_quality",
          trigger: "quality_failed",
          targetStepId: "w_plan",
          retryStepId: "w_code",
          maxAttempts: 2,
        },
      ],
    };
    const calls = [];
    const service = new PipelineBackflowService({
      state,
      orchestration: {
        async getLatestPlan(input) {
          assert.equal(input.taskRunId, taskRun.id);
          return plan;
        },
      },
      agentPlanning: {
        async invokeForWorker(input) {
          calls.push(input.profile.name);
          return { outputText: `${input.profile.name} output` };
        },
      },
    });

    assert.equal(
      await service.runForQualityFailure(qualityResult(taskRun.id, "failed")),
      true,
    );

    assert.deepEqual(calls, ["Planner", "Coder", "Tester"]);
    assert.equal((await state.getTaskRun(taskRun.id)).status, "ready_for_review");
    const attempts = await state.pipelineBackflows.listByTaskRun(taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].trigger, "quality_failed");
    assert.equal(attempts[0].status, "succeeded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

const createPendingFixture = async ({ maxAttempts = 1 } = {}) => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const taskRun = await seedTaskRun(state);
  await state.setTaskRunStatus(taskRun.id, "running");
  const profile = await state.agentProfiles.create(validProfileInput({ name: "Resume reviewer", role: "reviewer" }));
  const plan = {
    id: "orch_pending_quality", taskRunId: taskRun.id, mode: "multi_worker", requiresApproval: true,
    workerSteps: [{ id: "review", title: "Review", role: "reviewer", status: "pending",
      inputSummary: "Review the repair", instruction: "Review the repair", expectedArtifactKinds: ["log"],
      agentProfileId: profile.id, dependsOn: [] }],
    backflowRules: [{ id: "pending_quality", trigger: "quality_failed", targetStepId: "review", retryStepId: "review", maxAttempts }],
  };
  const attempt = await state.pipelineBackflows.createAttempt({ taskRunId: taskRun.id, planId: plan.id,
    ruleId: "pending_quality", trigger: "quality_failed", targetStepId: "review", retryStepId: "review", maxAttempts,
    reason: "quality failed before Pause" });
  return { db, state, taskRun, plan, attempt };
};

test("PipelineBackflowService resumes a persisted quality attempt after normal Resume", async () => {
  const f = await createPendingFixture();
  try {
    const calls = [];
    const service = new PipelineBackflowService({ state: f.state, orchestration: { getLatestPlan: async () => f.plan },
      agentPlanning: { invokeForWorker: async ({ profile }) => { calls.push(profile.name); return { outputText: "repair verified" }; } } });
    assert.equal(await service.resumePending(f.taskRun.id), true);
    assert.deepEqual(calls, ["Resume reviewer"]);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "ready_for_review");
    const attempts = await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id);
    assert.equal(attempts.length, 1, "Resume must continue the existing attempt without spending another budget slot");
    assert.equal(attempts[0].id, f.attempt.id);
    assert.equal(attempts[0].status, "succeeded");
  } finally { closeDb(f.db); }
});

test("PipelineBackflowService never resumes stopped work or an attempt from another plan", async () => {
  const f = await createPendingFixture();
  try {
    let calls = 0;
    const service = new PipelineBackflowService({ state: f.state,
      orchestration: { getLatestPlan: async () => ({ ...f.plan, id: "new-plan" }) },
      agentPlanning: { invokeForWorker: async () => { calls += 1; return { outputText: "unexpected" }; } } });
    assert.equal(await service.resumePending(f.taskRun.id), false);
    for (const status of ["paused", "blocked", "cancelled", "done"]) {
      await f.state.taskRuns.updateStatus(f.taskRun.id, status);
      assert.equal(await service.resumePending(f.taskRun.id), false);
    }
    assert.equal(calls, 0);
    assert.equal((await f.state.pipelineBackflows.getAttempt(f.attempt.id)).status, "running");
  } finally { closeDb(f.db); }
});

test("PipelineBackflowService coalesces initial quality execution and concurrent Resume events", async () => {
  const f = await createPendingFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  try {
    // Start a new quality run; the fixture's pending row belongs to another plan.
    const plan = { ...f.plan, id: "initial-quality" };
    let calls = 0;
    const service = new PipelineBackflowService({ state: f.state, orchestration: { getLatestPlan: async () => plan },
      agentPlanning: { invokeForWorker: async () => { calls += 1; entered(); await gate; return { outputText: "verified" }; } } });
    const initial = service.runForQualityFailure(qualityResult(f.taskRun.id, "failed"));
    await started;
    const resumes = Array.from({ length: 8 }, () => service.resumePending(f.taskRun.id));
    const repeated = service.runForQualityFailure(qualityResult(f.taskRun.id, "failed"));
    release();
    assert.deepEqual(await Promise.all([initial, repeated, ...resumes]), Array(10).fill(true));
    assert.equal(calls, 1);
    assert.equal((await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id)).filter(a => a.planId === plan.id).length, 1);
  } finally { release(); closeDb(f.db); }
});

test("quality backflow Pause and normal Resume continue through the real progression host", async () => {
  const f = await createPendingFixture();
  try {
    f.plan.workerSteps.push({ ...f.plan.workerSteps[0], id: "verify", title: "Verify", dependsOn: ["review"] });
    const parentStep = await f.state.createStep({ taskRunId: f.taskRun.id, index: 0, kind: "approval",
      title: "Original orchestration", status: "succeeded" });
    const checkpoint = await f.state.createCheckpoint({ taskRunId: f.taskRun.id, stepId: parentStep.id,
      reason: "before_edit", stateRef: JSON.stringify({ orchestrationPlanId: f.plan.id }), summary: "Original plan approval" });
    const parent = await f.state.createApproval({ taskRunId: f.taskRun.id, checkpointId: checkpoint.id,
      actionType: "orchestration_plan", actionSummary: "Original plan already executed" });
    await f.state.decideApproval(parent.id, "approved");
    await f.state.decideApproval(parent.id, "executed");
    const conversation = new ConversationService({ state: f.state, pathExists: async () => true });
    let calls = 0;
    const service = new PipelineBackflowService({ state: f.state, orchestration: { getLatestPlan: async () => f.plan },
      agentPlanning: { invokeForWorker: async () => {
        calls += 1;
        if (calls === 1) await conversation.pauseTask({ taskRunId: f.taskRun.id });
        return { outputText: `quality worker ${calls}` };
      } } });
    let qualityCalls = 0;
    const host = createTaskProgressionHost({ state: f.state, conversation,
      execute: async () => { assert.fail("the executed parent approval must not be replayed"); },
      resumeBackflow: id => service.resumePending(id),
      evaluateQuality: async () => { qualityCalls += 1; }, changed: () => {} });
    await host.advance(f.taskRun.id);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    assert.equal(calls, 1);
    assert.equal(qualityCalls, 0);
    await conversation.resumeTask({ taskRunId: f.taskRun.id });
    await host.advance(f.taskRun.id);
    assert.equal(calls, 2, "only the unfinished downstream worker may start after Resume");
    assert.equal(qualityCalls, 1);
    assert.equal((await f.state.getApproval(parent.id)).status, "executed");
    const attempts = await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].id, f.attempt.id);
    assert.equal(attempts[0].status, "succeeded");
  } finally { closeDb(f.db); }
});

for (const staleRunningPlan of [false, true]) {
test(`normal Resume blocks a quality worker that failed after Pause without spending another attempt (stale plan=${staleRunningPlan})`, async () => {
  const f = await createPendingFixture();
  try {
    const conversation = new ConversationService({ state: f.state, pathExists: async () => true });
    let calls = 0;
    const service = new PipelineBackflowService({ state: f.state, orchestration: { getLatestPlan: async () => f.plan },
      agentPlanning: { invokeForWorker: async () => {
        calls += 1;
        await conversation.pauseTask({ taskRunId: f.taskRun.id });
        throw new Error("provider failed after Pause");
      } } });
    assert.equal(await service.runForQualityFailure(qualityResult(f.taskRun.id, "failed")), true);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "paused");
    const failed = await f.state.pipelineBackflows.getAttempt(f.attempt.id);
    assert.equal(failed.status, "failed");
    assert.ok(failed.completedAt);
    if (staleRunningPlan) {
      await f.state.pipelineBackflows.createAttempt({ taskRunId: f.taskRun.id, planId: "old-plan",
        ruleId: "stale-quality", trigger: "quality_failed", targetStepId: "old-target", retryStepId: "old-retry", maxAttempts: 1 });
    }
    let qualityCalls = 0;
    const host = createTaskProgressionHost({ state: f.state, conversation,
      execute: async () => { assert.fail("Resume must not replay a terminal quality attempt"); },
      resumeBackflow: id => service.resumePending(id),
      evaluateQuality: async () => { qualityCalls += 1; }, changed: () => {} });
    await conversation.resumeTask({ taskRunId: f.taskRun.id });
    await host.advance(f.taskRun.id);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "blocked",
      "a failed continuation needs attention instead of remaining running forever");
    assert.equal(calls, 1);
    assert.equal(qualityCalls, 0);
    assert.equal((await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id)).length, staleRunningPlan ? 2 : 1);
    assert.match((await f.state.listArtifactsByTaskRun(f.taskRun.id)).find(a => a.title === "작업 진행 오류").summary,
      /Backflow|backflow/);
  } finally { closeDb(f.db); }
});
}

test("a new failed quality gate may explicitly retry a completed failed attempt within its budget", async () => {
  const f = await createPendingFixture({ maxAttempts: 2 });
  try {
    await f.state.pipelineBackflows.updateAttempt(f.attempt.id, { status: "failed", completedAt: now });
    await f.state.setTaskRunStatus(f.taskRun.id, "quality_failed");
    let calls = 0;
    const service = new PipelineBackflowService({ state: f.state, orchestration: { getLatestPlan: async () => f.plan },
      agentPlanning: { invokeForWorker: async () => { calls += 1; return { outputText: "explicit quality retry succeeded" }; } } });
    assert.equal(await service.runForQualityFailure(qualityResult(f.taskRun.id, "failed")), true);
    assert.equal(calls, 1);
    assert.equal((await f.state.getTaskRun(f.taskRun.id)).status, "ready_for_review");
    assert.deepEqual((await f.state.pipelineBackflows.listByTaskRun(f.taskRun.id))
      .sort((a, b) => a.attemptIndex - b.attemptIndex).map(a => a.status), ["failed", "succeeded"]);
  } finally { closeDb(f.db); }
});
