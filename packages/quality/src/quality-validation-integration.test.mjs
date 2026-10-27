import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, LocalStateService } from "../../storage/src/index.ts";
import { QualityEvaluator } from "./quality-evaluator.ts";

const fixture = async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "validation", targetDir: process.cwd() });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "파일을 수정해줘", intent: "change", targetDir: process.cwd(), status: "running" });
  const edit = await state.createStep({ taskRunId: task.id, index: 0, kind: "edit", title: "change", status: "succeeded" });
  await state.createArtifact({ taskRunId: task.id, stepId: edit.id, kind: "diff", title: "change", uri: "artifact://diff" });
  let fingerprint = "revision-A";
  const captureRevision = async () => ({ workspaceKey: "workspace", fingerprint });
  return { db, state, task, captureRevision, setFingerprint: value => { fingerprint = value; } };
};

const record = async (f, checkerId, exitCode = 0) => {
  const step = await f.state.createStep({ taskRunId: f.task.id, index: (await f.state.listStepsByTaskRun(f.task.id)).length,
    kind: "test", title: "node --test", status: "running" });
  const checkpoint = await f.state.createCheckpoint({ taskRunId: f.task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "run test" });
  let approval = await f.state.createApproval({ taskRunId: f.task.id, checkpointId: checkpoint.id, actionType: "shell", actionSummary: "node --test",
    proposedAction: { type: "shell", command: process.execPath, args: ["--test"] }, status: "pending" });
  approval = await f.state.decideApproval(approval.id, "approved", "run checker");
  await f.state.claimApprovalExecution(approval.id, approval.actionRevision, `claim-${step.id}`);
  const revision = await f.captureRevision();
  const run = await f.state.validationRuns.begin({ taskRunId: f.task.id, stepId: step.id, approvalId: approval.id,
    workspaceKey: revision.workspaceKey, checkerId, kinds: ["test"], startFingerprint: revision.fingerprint, startGeneration: 0 });
  const artifact = await f.state.createArtifact({ taskRunId: f.task.id, stepId: step.id, kind: "test_result", title: "node result", uri: `artifact://${step.id}` });
  await f.state.validationRuns.finish(run.id, { status: "completed", exitCode, artifactId: artifact.id,
    finishFingerprint: revision.fingerprint, finishGeneration: 0 });
  await f.state.setStepStatus(step.id, exitCode === 0 ? "succeeded" : "failed");
  await f.state.finishApprovalExecution(approval.id, `claim-${step.id}`, "succeeded");
  await f.state.decideApproval(approval.id, "executed", "complete checker");
  return run;
};

test("a SQLite echo result cannot mark build, tests and smoke passed", async () => {
  const f = await fixture();
  try {
    const step = await f.state.createStep({ taskRunId: f.task.id, index: 1, kind: "shell", title: "echo test build smoke", status: "succeeded" });
    await f.state.createArtifact({ taskRunId: f.task.id, stepId: step.id, kind: "log", title: "all passed", uri: "artifact://echo", summary: "exit=0" });
    const gate = await new QualityEvaluator({ state: f.state, captureRevision: f.captureRevision }).evaluate({ taskRunId: f.task.id, requireBuild: true, requireTests: true, requireSmoke: true });
    assert.notEqual(gate.status, "passed");
    assert.equal(gate.buildPassed, undefined);
    assert.equal(gate.testsPassed, undefined);
    assert.equal(gate.smokePassed, undefined);
  } finally { closeDb(f.db); }
});

test("SQLite latest exact checker succeeds after repair but keeps other checker failures", async () => {
  const f = await fixture();
  try {
    await record(f, "suite-A", 1);
    await record(f, "suite-A", 0);
    const evaluator = new QualityEvaluator({ state: f.state, captureRevision: f.captureRevision });
    const repaired = await evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(repaired.status, "passed");
    assert.equal(repaired.testsPassed, true);
    assert.equal(repaired.validationState?.watermark, 4);
    await record(f, "suite-B", 1);
    const failed = await evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(failed.status, "failed");
    assert.equal(failed.testsPassed, false);
  } finally { closeDb(f.db); }
});

test("a later source revision makes a SQLite success stale", async () => {
  const f = await fixture();
  try {
    await record(f, "suite-A", 0);
    f.setFingerprint("revision-B");
    const gate = await new QualityEvaluator({ state: f.state, captureRevision: f.captureRevision }).evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.notEqual(gate.status, "passed");
    assert.equal(gate.testsPassed, undefined);
  } finally { closeDb(f.db); }
});

test("source changes while evaluating cannot produce a new passed gate", async () => {
  const f = await fixture();
  try {
    await record(f, "suite-A", 0);
    let captures = 0;
    const gate = await new QualityEvaluator({ state: f.state, captureRevision: async () => ({ workspaceKey: "workspace", fingerprint: ++captures === 1 ? "revision-A" : "revision-B" }) })
      .evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.notEqual(gate.status, "passed");
    assert.equal(gate.testsPassed, undefined);
  } finally { closeDb(f.db); }
});
