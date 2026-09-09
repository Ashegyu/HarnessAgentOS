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
  getLatestQualityGateResult: async () => null,
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
