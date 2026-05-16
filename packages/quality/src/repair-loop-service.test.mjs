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
