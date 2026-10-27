import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, LocalStateService } from "../index.ts";

const fixture = async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "validation ledger", targetDir: process.cwd() });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "change source", targetDir: process.cwd(), status: "running" });
  const step = await state.createStep({ taskRunId: task.id, index: 0, kind: "test", title: "actual checker", status: "running" });
  const checkpoint = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_shell", stateRef: "{}", summary: "run checks" });
  const approval = await state.createApproval({ taskRunId: task.id, checkpointId: checkpoint.id, actionType: "shell", actionSummary: "node --test",
    status: "approved", proposedAction: { type: "shell", command: "node", args: ["--test"] } });
  await state.claimApprovalExecution(approval.id, approval.actionRevision, "validation-token");
  const input = { taskRunId: task.id, stepId: step.id, approvalId: approval.id, workspaceKey: "workspace-key", checkerId: "node-test",
    kinds: ["test"], startFingerprint: "revision-a", startGeneration: 0 };
  return { db, state, thread, task, step, approval, input };
};

test("validation execution has monotonic start identity, terminal provenance and immutable completion", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.state.validationRuns.getWatermark(f.task.id), 0);
    const run = await f.state.validationRuns.begin(f.input);
    assert.equal(run.status, "running");
    assert.equal(await f.state.validationRuns.getWatermark(f.task.id), 1);
    const artifact = await f.state.createArtifact({ taskRunId: f.task.id, stepId: f.step.id, kind: "test_result", title: "actual host result", uri: "harness:validation/test" });
    const completed = await f.state.validationRuns.finish(run.id, { status: "completed", exitCode: 0, artifactId: artifact.id,
      finishFingerprint: "revision-a", finishGeneration: 0 });
    assert.equal(completed.status, "completed");
    assert.equal(completed.exitCode, 0);
    assert.equal(await f.state.validationRuns.getWatermark(f.task.id), 2);
    await assert.rejects(f.state.validationRuns.finish(run.id, { status: "failed", exitCode: 1, finishFingerprint: "revision-a", finishGeneration: 0 }), /already|terminal|finished/i);
    const later = await f.state.validationRuns.begin({ ...f.input, checkerId: "other-check" });
    assert.ok(later.sequence > run.sequence);
    assert.equal(await f.state.validationRuns.getWatermark(f.task.id), 3);
  } finally { closeDb(f.db); }
});

test("validation provenance rejects unrelated steps, unclaimed approvals and foreign artifacts", async () => {
  const f = await fixture();
  try {
    const other = await f.state.createTaskRun({ threadId: f.thread.id, userRequest: "other", targetDir: process.cwd(), status: "running" });
    const otherStep = await f.state.createStep({ taskRunId: other.id, index: 0, kind: "test", title: "other", status: "running" });
    await assert.rejects(f.state.validationRuns.begin({ ...f.input, stepId: otherStep.id }), /provenance|linked|execution/i);
    await f.state.finishApprovalExecution(f.approval.id, "validation-token", "succeeded");
    await assert.rejects(f.state.validationRuns.begin(f.input), /provenance|linked|execution/i);
    f.db.prepare("UPDATE approvals SET execution_state='running' WHERE id=?").run(f.approval.id);
    const run = await f.state.validationRuns.begin(f.input);
    const artifact = await f.state.createArtifact({ taskRunId: other.id, stepId: otherStep.id, kind: "log", title: "foreign", uri: "harness:foreign" });
    await assert.rejects(f.state.validationRuns.finish(run.id, { status: "completed", exitCode: 0, artifactId: artifact.id,
      finishFingerprint: "revision-a", finishGeneration: 0 }), /artifact|provenance|linked/i);
    assert.equal((await f.state.validationRuns.listByTaskRun(f.task.id))[0].status, "running");
  } finally { closeDb(f.db); }
});

test("workspace mutations advance a shared generation and settle tokens idempotently", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 0, activeMutations: 0 });
    const a = await f.state.workspaceMutations.begin("workspace-key");
    const b = await f.state.workspaceMutations.begin("workspace-key");
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 2, activeMutations: 2 });
    await f.state.workspaceMutations.end(a);
    await f.state.workspaceMutations.end(a);
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 3, activeMutations: 1 });
    f.state.workspaceMutations.recoverAbandoned();
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 4, activeMutations: 0 });
    await f.state.workspaceMutations.end(b);
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 4, activeMutations: 0 });
  } finally { closeDb(f.db); }
});

test("quality gate stores its evaluated revision and ledger watermark", async () => {
  const f = await fixture();
  try {
    const gate = { id: "quality-validation", taskRunId: f.task.id, status: "passed", testsPassed: true, knownRisks: [], evidenceArtifactIds: [],
      createdAt: new Date().toISOString(), validationState: { workspaceKey: "workspace-key", fingerprint: "revision-a", generation: 0, watermark: 0 } };
    await f.state.createQualityGateResult(gate);
    assert.deepEqual((await f.state.getLatestQualityGateResult(f.task.id)).validationState, gate.validationState);
  } finally { closeDb(f.db); }
});

test("validation rows cascade when their task is deleted without changing workspace generation", async () => {
  const f = await fixture();
  try {
    await f.state.validationRuns.begin(f.input);
    const token = await f.state.workspaceMutations.begin("workspace-key");
    await f.state.workspaceMutations.end(token);
    await f.state.deleteTaskRun(f.task.id);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM validation_runs").get().count, 0);
    assert.deepEqual(await f.state.workspaceMutations.get("workspace-key"), { generation: 2, activeMutations: 0 });
  } finally { closeDb(f.db); }
});
