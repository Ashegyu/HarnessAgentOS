import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRunCompletionService } from "./task-run-completion-service.ts";

const taskRun = {
  id: "tr-failed",
  threadId: "th-1",
  userRequest: "fix tests",
  targetDir: "/tmp/project",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const failedGate = {
  id: "qg-failed",
  taskRunId: taskRun.id,
  status: "failed",
  testsPassed: false,
  changedFilesReviewed: true,
  knownRisks: ["test command failed"],
  evidenceArtifactIds: ["art-test"],
  createdAt: "2026-01-01T00:00:01.000Z",
};

const makeGateway = (overrides = {}) => ({
  getTaskRun: async () => taskRun,
  setTaskRunStatus: async (_id, status) => ({
    ...taskRun,
    status,
  }),
  getLatestQualityGateResult: async () => failedGate,
  assertQualityGateCurrent: async () => {},
  completeTaskRun: async () => ({ ...taskRun, status: "done" }),
  applyQualityGateStatus: async (_gate, status) => ({ ...taskRun, status }),
  listArtifactsByTaskRun: async () => [],
  listStepsByTaskRun: async () => [],
  listApprovalsByTaskRun: async () => [],
  createStep: async () => {
    throw new Error("not implemented");
  },
  createArtifact: async () => {
    throw new Error("not implemented");
  },
  ...overrides,
});

for (const changed of ["workspace", "new validation result"]) {
  test(`markDone rejects an unchanged gate after ${changed} arrives during the learning hook`, async () => {
    let stale = false;
    let commits = 0;
    const service = new TaskRunCompletionService({
      state: makeGateway({
        getTaskRun: async () => ({ ...taskRun, status: "ready_for_review" }),
        getLatestQualityGateResult: async () => ({ ...failedGate, status: "passed" }),
        assertQualityGateCurrent: async () => { if (stale) throw new Error("QUALITY_DONE_BLOCKED: evidence is stale"); },
        completeTaskRun: async () => { commits += 1; return { ...taskRun, status: "done" }; },
      }),
      onTaskRunDone: async () => { stale = true; },
    });
    await assert.rejects(service.markDone({ taskRunId: taskRun.id }), /QUALITY_DONE_BLOCKED/);
    assert.equal(commits, 0);
  });
}

test("markDone commits through the final gate and workspace clock compare-and-set", async () => {
  let unsafeWrites = 0;
  const service = new TaskRunCompletionService({ state: makeGateway({
    getTaskRun: async () => ({ ...taskRun, status: "ready_for_review" }),
    getLatestQualityGateResult: async () => ({ ...failedGate, status: "passed" }),
    setTaskRunStatus: async () => { unsafeWrites += 1; return { ...taskRun, status: "done" }; },
    completeTaskRun: async () => { throw new Error("QUALITY_DONE_BLOCKED: workspace clock changed before commit"); },
  }) });
  await assert.rejects(service.markDone({ taskRunId: taskRun.id }), /workspace clock changed/);
  assert.equal(unsafeWrites, 0);
});

test("an older quality evaluation cannot overwrite the latest gate's task state", async () => {
  let writes = 0;
  const service = new TaskRunCompletionService({ state: makeGateway({
    getLatestQualityGateResult: async () => ({ ...failedGate, id: "newer", status: "passed" }),
    setTaskRunStatus: async () => { writes += 1; return { ...taskRun, status: "quality_failed" }; },
  }) });
  const current = await service.applyQualityGateResult(failedGate);
  assert.equal(current.status, "running");
  assert.equal(writes, 0);
});

for (const action of ["markReadyForReview", "approveKnownRisks"]) {
  test(`${action} rejects a warning whose checked code or checker results changed`, async () => {
    const service = new TaskRunCompletionService({ state: makeGateway({
      getLatestQualityGateResult: async () => ({ ...failedGate, status: "warning" }),
      assertQualityGateCurrent: async () => { throw new Error("QUALITY_DONE_BLOCKED: stale warning"); },
    }) });
    await assert.rejects(service[action]({ taskRunId: taskRun.id, message: "reviewed risks" }), /stale warning/);
  });
}

for (const change of ["approval", "gate"]) {
  test(`markDone revalidates ${change} after asynchronous completion hooks`, async () => {
    let changed = false;
    const service = new TaskRunCompletionService({
      state: makeGateway({
        getTaskRun: async () => ({ ...taskRun, status: "ready_for_review" }),
        getLatestQualityGateResult: async () => ({ ...failedGate, id: changed && change === "gate" ? "new-failed" : "passed", status: changed && change === "gate" ? "failed" : "passed" }),
        listApprovalsByTaskRun: async () => changed && change === "approval" ? [{ status: "pending", actionType: "file_write" }] : [],
      }),
      onTaskRunDone: async () => { changed = true; },
    });
    await assert.rejects(service.markDone({ taskRunId: taskRun.id }), /QUALITY_DONE_BLOCKED|변경|승인|실행/);
  });
}

for (const status of ["pending", "approved", "always_approved_for_run"]) {
  test(`markDone rejects ${status} execution even with an old passing gate`, async () => {
    const service = new TaskRunCompletionService({ state: makeGateway({
      getTaskRun: async () => ({ ...taskRun, status: "ready_for_review" }),
      getLatestQualityGateResult: async () => ({ ...failedGate, status: "passed" }),
      listApprovalsByTaskRun: async () => [{ id: "other-checkpoint", status, actionType: "file_write" }],
    }) });
    await assert.rejects(service.markDone({ taskRunId: taskRun.id }), /unresolved|승인|실행/);
  });
}

test("markDone rejects active runner steps even if the task row is stale", async () => {
  const service = new TaskRunCompletionService({ state: makeGateway({
    getTaskRun: async () => ({ ...taskRun, status: "ready_for_review" }),
    getLatestQualityGateResult: async () => ({ ...failedGate, status: "passed" }),
    listStepsByTaskRun: async () => [{ status: "running" }],
  }) });
  await assert.rejects(service.markDone({ taskRunId: taskRun.id }), /running|실행/);
});

test("applyQualityGateResult reports failed gates to advisory learner hook", async () => {
  let observedGate = null;
  const service = new TaskRunCompletionService({
    state: makeGateway(),
    onQualityGateFailed: async (gate) => {
      observedGate = gate;
    },
  });

  const updated = await service.applyQualityGateResult(failedGate);

  assert.equal(updated.status, "quality_failed");
  assert.equal(observedGate?.id, failedGate.id);
  assert.equal(observedGate?.status, "failed");
});

test("applyQualityGateResult keeps failed status transition when advisory learner hook throws", async () => {
  const service = new TaskRunCompletionService({
    state: makeGateway(),
    onQualityGateFailed: async () => {
      throw new Error("trace store unavailable");
    },
  });

  const updated = await service.applyQualityGateResult(failedGate);

  assert.equal(updated.status, "quality_failed");
});
