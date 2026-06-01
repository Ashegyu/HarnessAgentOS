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
  createStep: async () => {
    throw new Error("not implemented");
  },
  createArtifact: async () => {
    throw new Error("not implemented");
  },
  ...overrides,
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
