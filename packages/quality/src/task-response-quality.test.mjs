import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskContract } from "@harness/core";
import { QualityEvaluator } from "./quality-evaluator.ts";

const fixture = (intent, overrides = {}) => {
  const task = { id: "task", userRequest: "요청한 결과", status: "ready_for_review",
    contract: buildTaskContract({ userRequest: "요청한 결과", intent }) };
  return {
    getTaskRun: async () => task,
    listStepsByTaskRun: async () => [{ id: "step", taskRunId: "task", index: 0, kind: "plan", status: "succeeded", title: "Agent plan" }],
    listArtifactsByTaskRun: async () => [{ id: "answer", taskRunId: "task", stepId: "step", kind: "plan", summary: "요청에 대한 답변" }],
    listAgentInvocationsByTaskRun: async () => [{ id: "inv", taskRunId: "task", status: "succeeded", parsedPlanArtifactId: "answer", createdAt: "2026-09-07T01:00:00Z" }],
    createQualityGateResult: async result => result,
    ...overrides,
  };
};

test("verified report delivery does not require unrelated code tests", async () => {
  const state = fixture("change", {
    listStepsByTaskRun: async () => [{ id: "edit", taskRunId: "task", index: 0, kind: "edit", status: "succeeded" }],
    listArtifactsByTaskRun: async () => [{ id: "diff", taskRunId: "task", kind: "diff", stepId: "edit" }],
  });
  const evaluator = new QualityEvaluator({ state, verifyReportDelivery: async () => true });
  const result = await evaluator.evaluate({ taskRunId: "task" });
  assert.equal(result.status, "passed");
  assert.equal(result.testsPassed, undefined);
  assert.equal(result.buildPassed, undefined);
  assert.equal((await evaluator.evaluate({ taskRunId: "task", requireTests: true })).status, "warning");
});

test("a validated plain answer finishes without fabricated build/test results", async () => {
  const result = await new QualityEvaluator({ state: fixture("answer") }).evaluate({ taskRunId: "task" });
  assert.equal(result.status, "passed");
  assert.equal(result.buildPassed, undefined);
  assert.equal(result.testsPassed, undefined);
  assert.deepEqual(result.evidenceArtifactIds, ["answer"]);
});

test("a plain read-only answer does not depend on a workspace snapshot", async () => {
  const state = fixture("answer");
  const getTaskRun = state.getTaskRun;
  state.getTaskRun = async () => ({ ...await getTaskRun(), targetDir: "/unreadable-answer-workspace" });
  let captures = 0;
  const result = await new QualityEvaluator({ state, captureRevision: async () => {
    captures += 1;
    return { workspaceKey: "answer-workspace", fingerprint: null };
  } }).evaluate({ taskRunId: "task" });
  assert.equal(result.status, "passed");
  assert.equal(result.validationState, undefined);
  assert.equal(captures, 0);
});

test("explicitly required checks keep workspace freshness for a plain answer", async () => {
  const state = fixture("answer");
  const getTaskRun = state.getTaskRun;
  state.getTaskRun = async () => ({ ...await getTaskRun(), targetDir: "/answer-workspace" });
  let captures = 0;
  const result = await new QualityEvaluator({ state, captureRevision: async () => {
    captures += 1;
    return { workspaceKey: "answer-workspace", fingerprint: "current" };
  } }).evaluate({ taskRunId: "task", requireTests: true });
  assert.equal(result.status, "warning");
  assert.equal(result.validationState?.fingerprint, "current");
  assert.equal(captures, 2);
});

for (const intent of ["review", "diagnose", "research"]) {
  test(`${intent} stops at content review without requesting irrelevant build QA`, async () => {
    const result = await new QualityEvaluator({ state: fixture(intent) }).evaluate({ taskRunId: "task" });
    assert.equal(result.status, "warning");
    assert.match(result.knownRisks.join(" "), /내용.*확인/);
    assert.doesNotMatch(result.knownRisks.join(" "), /required tests|build evidence/);
    assert.deepEqual(result.evidenceArtifactIds, ["answer"]);
  });
}

for (const status of ["running", "failed", "cancelled"]) {
  test(`an answer with a ${status} invocation cannot be marked completed`, async () => {
    const state = fixture("answer", { listAgentInvocationsByTaskRun: async () => [
      { id: "older", taskRunId: "task", status: "succeeded", parsedPlanArtifactId: "answer", createdAt: "2026-09-06T00:00:00Z" },
      { id: "newer", taskRunId: "task", status, createdAt: "2026-09-07T00:00:00Z" },
    ] });
    assert.notEqual((await new QualityEvaluator({ state }).evaluate({ taskRunId: "task" })).status, "passed");
  });
}

test("a missing or cross-task final artifact cannot validate an answer", async () => {
  for (const artifacts of [[], [{ id: "answer", taskRunId: "another", kind: "plan", summary: "wrong task" }]]) {
    const state = fixture("answer", { listArtifactsByTaskRun: async () => artifacts });
    assert.notEqual((await new QualityEvaluator({ state }).evaluate({ taskRunId: "task" })).status, "passed");
  }
});

test("explicitly required checks are not bypassed by a plain answer", async () => {
  const result = await new QualityEvaluator({ state: fixture("answer") }).evaluate({ taskRunId: "task", requireTests: true });
  assert.notEqual(result.status, "passed");
});

test("read-only answers fail if execution recorded file changes", async () => {
  const state = fixture("answer", {
    listStepsByTaskRun: async () => [
      { id: "step", taskRunId: "task", index: 0, kind: "plan", status: "succeeded" },
      { id: "edit", taskRunId: "task", index: 1, kind: "edit", status: "succeeded" },
    ],
  });
  const result = await new QualityEvaluator({ state }).evaluate({ taskRunId: "task" });
  assert.equal(result.status, "failed");
  assert.match(result.knownRisks.join(" "), /읽기 전용.*변경/);
});

test("a change request with only model prose is incomplete", async () => {
  const result = await new QualityEvaluator({ state: fixture("change") }).evaluate({ taskRunId: "task" });
  assert.equal(result.status, "warning");
  assert.match(result.knownRisks.join(" "), /변경.*근거/);
});

test("a diff proves a change exists, not that someone reviewed it", async () => {
  const state = fixture("change", {
    listStepsByTaskRun: async () => [
      { id: "edit", taskRunId: "task", index: 0, kind: "edit", status: "succeeded" },
      { id: "test", taskRunId: "task", index: 1, kind: "test", status: "succeeded" },
    ],
    listArtifactsByTaskRun: async () => [{ id: "diff", taskRunId: "task", kind: "diff", stepId: "edit" },
      { id: "host-result", taskRunId: "task", kind: "test_result", stepId: "test" }],
    validationRuns: { getWatermark: async () => 2, listByTaskRun: async () => [{
      id: "check", sequence: 1, taskRunId: "task", stepId: "test", approvalId: "approved", workspaceKey: "workspace", checkerId: "suite", kinds: ["test"],
      startFingerprint: "current", finishFingerprint: "current", startGeneration: 0, finishGeneration: 0,
      status: "completed", exitCode: 0, artifactId: "host-result", startedAt: "now", finishedAt: "now",
    }] },
  });
  const getTaskRun = state.getTaskRun;
  state.getTaskRun = async () => ({ ...await getTaskRun(), targetDir: "/fixture" });
  const result = await new QualityEvaluator({ state, captureRevision: async () => ({ workspaceKey: "workspace", fingerprint: "current" }) }).evaluate({ taskRunId: "task" });
  assert.equal(result.changedFilesReviewed, false);
  assert.equal(result.testsPassed, true);
});
