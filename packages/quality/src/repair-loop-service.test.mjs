import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskRunCompletionService,
  TaskRunCompletionError,
} from "@harness/core";
import { openDb, closeDb, LocalStateService } from "@harness/storage";
import { RepairLoopService, failureSignature } from "./repair-loop-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-repair-loop-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seed = async (state, gatePatch = {}) => {
  const thread = await state.createThread({ title: "repair loop" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "fix quality failure",
    targetDir: process.cwd(),
  });
  const gate = await state.createQualityGateResult({
    id: gatePatch.id ?? "qg-1",
    taskRunId: taskRun.id,
    status: "failed",
    testsPassed: false,
    knownRisks: ["unit tests failed"],
    evidenceArtifactIds: ["art-test"],
    createdAt: "2026-05-16T00:00:00.000Z",
    ...gatePatch,
  });
  await state.setTaskRunStatus(taskRun.id, "quality_failed");
  return { taskRun: await state.getTaskRun(taskRun.id), gate };
};

const makeCompletion = (state) => new TaskRunCompletionService({ state });

test("failure signatures ignore recording identity and use an unordered set of exact risks", () => {
  const gate = { id: "old", taskRunId: "task", status: "failed", testsPassed: false,
    knownRisks: ["tests failed", "build missing"], evidenceArtifactIds: ["old-log"], createdAt: "2020-01-01" };
  assert.equal(failureSignature(gate), failureSignature({ ...gate, id: "new", evidenceArtifactIds: ["new-log", "new-diff"],
    createdAt: "2030-01-01", knownRisks: ["build missing", "tests failed", "tests failed"],
    validationState: { workspaceKey: "other", fingerprint: "new", generation: 42, watermark: 100 } }));
  assert.notEqual(failureSignature(gate), failureSignature({ ...gate, knownRisks: ["different failure"] }));
  assert.notEqual(failureSignature(gate), failureSignature({ ...gate, testsPassed: true }));
});

for (const legacy of [false, true]) {
  test(`the same failure with new artifact IDs stops before another model call (${legacy ? "legacy history" : "new history"})`, async () => {
    const db = openDb({ filePath: ":memory:" });
    try {
      const state = new LocalStateService(db);
      const { taskRun, gate } = await seed(state);
      let calls = 0;
      const planning = makeAgentPlanningStub(state);
      const service = new RepairLoopService({ state, completion: makeCompletion(state), maxAttempts: 4,
        agentPlanning: { generatePlan: async input => { calls++; return planning.generatePlan(input); } } });
      if (legacy) await state.repairAttempts.create({ taskRunId: taskRun.id, qualityGateId: gate.id, failureSignature: "historical-v1-hash", status: "stopped" });
      else await service.createRepairPlan({ taskRunId: taskRun.id });
      const beforeCalls = calls;
      await state.createQualityGateResult({ ...gate, id: "reexecuted-gate", evidenceArtifactIds: ["different-artifact-id"], createdAt: "2026-06-01" });
      await state.setTaskRunStatus(taskRun.id, "quality_failed");
      await assert.rejects(service.createRepairPlan({ taskRunId: taskRun.id }), error => error.code === "QUALITY_DONE_BLOCKED" && /same quality failure signature/.test(error.message));
      assert.equal(calls, beforeCalls);
      assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id)).length, 1);
    } finally { closeDb(db); }
  });
}

const makeAgentPlanningStub = (state) => ({
  generatePlan: async ({ taskRunId, instruction }) => {
    assert.ok(instruction.includes("QUALITY REPAIR LOOP"));
    const taskRun = await state.getTaskRun(taskRunId);
    const step = await state.createStep({
      taskRunId,
      index: (await state.listStepsByTaskRun(taskRunId)).length,
      kind: "plan",
      title: "Agent repair",
      status: "succeeded",
      inputSummary: instruction.slice(0, 120),
    });
    const planArtifact = await state.createArtifact({
      taskRunId,
      stepId: step.id,
      kind: "plan",
      title: "Agent repair plan",
      uri: `harness:test-plan/${taskRunId}`,
      summary: "targeted repair",
    });
    const promptArtifact = await state.createArtifact({
      taskRunId,
      stepId: step.id,
      kind: "log",
      title: "Agent prompt",
      uri: `harness:test-prompt/${taskRunId}`,
      summary: instruction,
    });
    const invocation = await state.createAgentInvocation({
      taskRunId,
      stepId: step.id,
      provider: "codex",
      model: "gpt-test",
      promptArtifactId: promptArtifact.id,
    });
    const approvalStep = await state.createStep({
      taskRunId,
      index: (await state.listStepsByTaskRun(taskRunId)).length,
      kind: "approval",
      title: "Agent repair approval",
      status: "pending",
      inputSummary: "file_write",
    });
    const checkpoint = await state.createCheckpoint({
      taskRunId,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        invocationId: invocation.id,
        targetDir: taskRun.targetDir,
      }),
      summary: "repair checkpoint",
    });
    const approval = await state.createApproval({
      taskRunId,
      checkpointId: checkpoint.id,
      actionType: "file_write",
      actionSummary: "repair src/index.ts",
      status: "pending",
    });
    await state.setTaskRunCurrentStep(taskRunId, approvalStep.id);
    await state.setTaskRunStatus(taskRunId, "waiting_for_approval");
    return {
      invocation,
      planArtifact,
      approvals: [approval],
    };
  },
});

test("repair reviews failed assertions against the contract before changing implementation", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seed(state);
    const planning = makeAgentPlanningStub(state);
    let instruction;
    const service = new RepairLoopService({ state, completion: makeCompletion(state),
      agentPlanning: { generatePlan: async input => { instruction = input.instruction; return planning.generatePlan(input); } } });
    const draft = await service.createRepairPlan({ taskRunId: taskRun.id });
    assert.match(instruction, /failed assertion.*user contract/i);
    assert.match(instruction, /test itself can be wrong/i);
    assert.match(instruction, /preserve existing valid regression coverage/i);
    assert.match(instruction, /known-good.*original defect/i);
    assert.equal(draft.approvals[0].status, "pending");
    assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id)).length, 1);
  } finally { closeDb(db); }
});

test("RepairLoopService creates agent repair attempt and approval-gated draft", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, gate } = await seed(state);
    const svc = new RepairLoopService({
      state,
      completion: makeCompletion(state),
      agentPlanning: makeAgentPlanningStub(state),
    });
    const draft = await svc.createRepairPlan({
      taskRunId: taskRun.id,
      instruction: "prefer a minimal fix",
    });
    assert.equal(draft.source, "agent");
    assert.ok(draft.repairAttemptId);
    assert.equal(draft.approvals.length, 1);
    assert.equal(draft.checkpoint.summary, "repair checkpoint");
    const attempts = await state.repairAttempts.listByTaskRun(taskRun.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "waiting_for_approval");
    assert.equal(attempts[0].failureSignature, failureSignature(gate));
    assert.deepEqual(attempts[0].generatedApprovalIds, [draft.approvals[0].id]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("RepairLoopService stops repeated failure signatures", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun, gate } = await seed(state);
    await state.repairAttempts.create({
      taskRunId: taskRun.id,
      qualityGateId: gate.id,
      failureSignature: failureSignature(gate),
      status: "failed",
    });
    const svc = new RepairLoopService({
      state,
      completion: makeCompletion(state),
      agentPlanning: makeAgentPlanningStub(state),
    });
    await assert.rejects(
      () => svc.createRepairPlan({ taskRunId: taskRun.id }),
      (error) =>
        error instanceof TaskRunCompletionError &&
        error.message.includes("same quality failure signature"),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("RepairLoopService falls back to template repair when provider is unavailable", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seed(state);
    const svc = new RepairLoopService({
      state,
      completion: makeCompletion(state),
      agentPlanning: {
        generatePlan: async () => {
          throw new Error("No agent CLI provider is available");
        },
      },
    });
    const draft = await svc.createRepairPlan({ taskRunId: taskRun.id });
    assert.equal(draft.source, "template");
    assert.equal(draft.approvals.length, 1);
    const attempts = await state.repairAttempts.listByTaskRun(taskRun.id);
    assert.equal(attempts[0].status, "stopped");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

for (const { name, maxAttempts, priorAttempts } of [
  { name: "duplicate signature", maxAttempts: 4, priorAttempts: 0 },
  { name: "last remaining attempt", maxAttempts: 2, priorAttempts: 1 },
]) {
  test(`RepairLoopService atomically reserves ${name} across two SQLite connections`, async () => {
    const t = tmp();
    const db = openDb({ filePath: t.file });
    let secondDb;
    try {
      const state = new LocalStateService(db);
      const { taskRun, gate } = await seed(state);
      for (let i = 0; i < priorAttempts; i++) {
        const previous = await state.createQualityGateResult({ ...gate, id: `prior-gate-${i}`, knownRisks: [`previous failure ${i}`] });
        await state.repairAttempts.create({ taskRunId: taskRun.id, qualityGateId: previous.id,
          failureSignature: `previous-${i}`, status: "stopped" });
      }
      // Previous attempts need distinct source failures, not arbitrary hashes
      // for the same gate. Reinsert the current failure as the latest gate.
      if (priorAttempts) {
        gate.id = "current-gate";
        await state.createQualityGateResult(gate);
      }
      secondDb = openDb({ filePath: t.file });
      const secondState = new LocalStateService(secondDb);
      let modelCalls = 0;
      const services = [state, secondState].map(current => {
        const planning = makeAgentPlanningStub(current);
        return new RepairLoopService({ state: current, completion: makeCompletion(current), maxAttempts,
          agentPlanning: { generatePlan: async input => { modelCalls++; return planning.generatePlan(input); } } });
      });
      const results = await Promise.allSettled([0, 1, 0].map(index =>
        services[index].createRepairPlan({ taskRunId: taskRun.id })));
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1,
        "only the owner of the reserved signature may create a model plan");
      assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "QUALITY_DONE_BLOCKED").length, 2);
      assert.equal(modelCalls, 1);
      const attempts = await state.repairAttempts.listByTaskRun(taskRun.id);
      assert.equal(attempts.length, priorAttempts + 1);
      assert.equal(attempts.filter(attempt => attempt.failureSignature === failureSignature(gate)).length, 1);
      assert.deepEqual(attempts.map(attempt => attempt.attemptIndex), Array.from({ length: priorAttempts + 1 }, (_, i) => i));
    } finally {
      if (secondDb) closeDb(secondDb);
      closeDb(db);
      t.cleanup();
    }
  });
}

test("RepairLoopService rejects a stale gate before reserving or starting a model", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun, gate } = await seed(state);
    const getLatest = state.getLatestQualityGateResult.bind(state);
    let changed = false;
    state.getLatestQualityGateResult = async id => {
      const snapshot = await getLatest(id);
      if (!changed) {
        changed = true;
        await state.createQualityGateResult({ ...gate, id: "new-passed-gate", status: "passed",
          testsPassed: true, knownRisks: [], createdAt: "2026-05-16T00:00:01.000Z" });
      }
      return snapshot;
    };
    let modelCalls = 0;
    const planning = makeAgentPlanningStub(state);
    const service = new RepairLoopService({ state, completion: makeCompletion(state),
      agentPlanning: { generatePlan: async input => { modelCalls++; return planning.generatePlan(input); } } });
    await assert.rejects(service.createRepairPlan({ taskRunId: taskRun.id }), error =>
      error.code === "QUALITY_DONE_BLOCKED" && /quality gate changed/i.test(error.message));
    assert.equal(modelCalls, 0);
    assert.deepEqual(await state.repairAttempts.listByTaskRun(taskRun.id), []);
    assert.deepEqual(await state.listArtifactsByTaskRun(taskRun.id), []);
  } finally { closeDb(db); }
});

test("RepairLoopService rolls back a failed reservation and can reserve after storage recovers", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seed(state);
    db.exec("CREATE TRIGGER reject_repair AFTER INSERT ON repair_attempts BEGIN SELECT RAISE(ABORT, 'reservation interrupted'); END");
    let modelCalls = 0;
    const planning = makeAgentPlanningStub(state);
    const service = new RepairLoopService({ state, completion: makeCompletion(state), maxAttempts: 1,
      agentPlanning: { generatePlan: async input => { modelCalls++; return planning.generatePlan(input); } } });
    await assert.rejects(service.createRepairPlan({ taskRunId: taskRun.id }), /reservation interrupted/);
    assert.equal(modelCalls, 0);
    assert.equal(db.inTransaction, false);
    assert.deepEqual(await state.repairAttempts.listByTaskRun(taskRun.id), []);
    db.exec("DROP TRIGGER reject_repair");
    const draft = await service.createRepairPlan({ taskRunId: taskRun.id });
    assert.equal(draft.source, "agent");
    assert.equal(modelCalls, 1);
    assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id))[0].attemptIndex, 0);
  } finally { closeDb(db); }
});

test("RepairLoopService reservations for one task do not suppress another task with the same failure", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const first = await seed(state);
    const second = await seed(state, { id: "qg-2" });
    const service = new RepairLoopService({ state, completion: makeCompletion(state), maxAttempts: 1,
      agentPlanning: makeAgentPlanningStub(state) });
    const drafts = await Promise.all([first, second].map(({ taskRun }) => service.createRepairPlan({ taskRunId: taskRun.id })));
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every(draft => draft.source === "agent"));
    assert.equal((await state.repairAttempts.listByTaskRun(first.taskRun.id)).length, 1);
    assert.equal((await state.repairAttempts.listByTaskRun(second.taskRun.id)).length, 1);
  } finally { closeDb(db); }
});
