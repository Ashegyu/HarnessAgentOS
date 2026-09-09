import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomaticQualityService } from "./automatic-quality-service.ts";

const taskRun = (status = "ready_for_review") => ({
  id: "tsk_1",
  threadId: "thr_1",
  userRequest: "소스를 수정해줘",
  targetDir: "C:\\repo",
  status,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
});

const gate = (status) => ({
  id: `qg_${status}`,
  taskRunId: "tsk_1",
  status,
  knownRisks: status === "warning" ? ["tests missing"] : [],
  evidenceArtifactIds: ["art_1"],
  createdAt: "2026-09-03T00:00:01.000Z",
});

test("automatic QA evaluates ready work and completes a passed gate", async () => {
  const calls = [];
  const service = new AutomaticQualityService({
    state: { getTaskRun: async () => taskRun() },
    evaluator: {
      evaluate: async (input) => {
        calls.push(["evaluate", input]);
        return gate("passed");
      },
    },
    completion: {
      applyQualityGateResult: async (result) => {
        calls.push(["apply", result.status]);
        return taskRun();
      },
      markDone: async (input) => {
        calls.push(["done", input]);
        return taskRun("done");
      },
    },
    onQualityGate: async (result) => calls.push(["observe", result.status]),
    onTaskRunChanged: (taskRunId) => calls.push(["changed", taskRunId]),
  });

  const result = await service.evaluateIfReady("tsk_1");

  assert.equal(result?.status, "passed");
  assert.deepEqual(calls, [
    ["evaluate", { taskRunId: "tsk_1" }],
    ["apply", "passed"],
    ["observe", "passed"],
    ["done", { taskRunId: "tsk_1" }],
    ["changed", "tsk_1"],
  ]);
});

test("automatic QA leaves warning gates for explicit risk review", async () => {
  let markDoneCalls = 0;
  const service = new AutomaticQualityService({
    state: { getTaskRun: async () => taskRun() },
    evaluator: { evaluate: async () => gate("warning") },
    completion: {
      applyQualityGateResult: async () => taskRun(),
      markDone: async () => {
        markDoneCalls += 1;
        return taskRun("done");
      },
    },
  });

  const result = await service.evaluateIfReady("tsk_1");

  assert.equal(result?.status, "warning");
  assert.equal(markDoneCalls, 0);
});

test("automatic QA routes failed gates to the existing quality backflow", async () => {
  const failures = [];
  let markDoneCalls = 0;
  const service = new AutomaticQualityService({
    state: { getTaskRun: async () => taskRun() },
    evaluator: { evaluate: async () => gate("failed") },
    completion: {
      applyQualityGateResult: async () => taskRun("quality_failed"),
      markDone: async () => {
        markDoneCalls += 1;
        return taskRun("done");
      },
    },
    onQualityFailure: async (result) => failures.push(result.id),
  });

  const result = await service.evaluateIfReady("tsk_1");

  assert.equal(result?.status, "failed");
  assert.deepEqual(failures, ["qg_failed"]);
  assert.equal(markDoneCalls, 0);
});

test("automatic QA ignores work that is not ready for review", async () => {
  let evaluateCalls = 0;
  const service = new AutomaticQualityService({
    state: { getTaskRun: async () => taskRun("running") },
    evaluator: {
      evaluate: async () => {
        evaluateCalls += 1;
        return gate("passed");
      },
    },
    completion: {
      applyQualityGateResult: async () => taskRun(),
      markDone: async () => taskRun("done"),
    },
  });

  assert.equal(await service.evaluateIfReady("tsk_1"), null);
  assert.equal(evaluateCalls, 0);
});
