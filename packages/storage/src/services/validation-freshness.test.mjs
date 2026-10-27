import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, closeDb, LocalStateService, captureValidationRevision } from "../index.ts";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "hgos-validation-freshness-"));
  await writeFile(join(directory, "source.txt"), "source A");
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "quality freshness", targetDir: directory });
  const task = await state.createTaskRun({ threadId: thread.id, targetDir: directory, userRequest: "change source", status: "ready_for_review" });
  let gates = 0;
  const gate = async (patch = {}) => {
    const snapshot = await captureValidationRevision(directory);
    assert.notEqual(snapshot.fingerprint, null);
    const epoch = await state.workspaceMutations.get(snapshot.workspaceKey);
    const result = { id: `gate-${++gates}`, taskRunId: task.id, status: "passed", testsPassed: true,
      knownRisks: [], evidenceArtifactIds: [], createdAt: new Date().toISOString(),
      validationState: { workspaceKey: snapshot.workspaceKey, fingerprint: snapshot.fingerprint,
        generation: epoch.generation, watermark: await state.validationRuns.getWatermark(task.id) }, ...patch };
    return state.createQualityGateResult(result);
  };
  return { directory, db, state, task, gate,
    close: async () => { closeDb(db); await rm(directory, { recursive: true, force: true }); } };
};

test("a gate cannot be reused after a source edit even when its status stays passed", async () => {
  const f = await fixture();
  try {
    const gate = await f.gate();
    await f.state.assertQualityGateCurrent(gate);
    await writeFile(join(f.directory, "source.txt"), "source B");
    await assert.rejects(f.state.assertQualityGateCurrent(gate), error => error.code === "QUALITY_DONE_BLOCKED");
  } finally { await f.close(); }
});

test("gate insertion downgrades a stale generation and removes passing check claims", async () => {
  const f = await fixture();
  try {
    const base = await f.gate();
    const token = await f.state.workspaceMutations.begin(base.validationState.workspaceKey);
    const stored = await f.state.createQualityGateResult({ ...base, id: "raced-gate" });
    assert.equal(stored.status, "warning");
    assert.equal(stored.testsPassed, undefined);
    assert.match(stored.knownRisks.join("\n"), /changed during quality evaluation/);
    await f.state.workspaceMutations.end(token);
  } finally { await f.close(); }
});

test("the final done CAS refuses a mutation that begins after filesystem freshness was checked", async () => {
  const f = await fixture();
  try {
    const gate = await f.gate();
    await f.state.assertQualityGateCurrent(gate);
    const token = await f.state.workspaceMutations.begin(gate.validationState.workspaceKey);
    await assert.rejects(f.state.completeTaskRun(f.task.id, gate.id), error => error.code === "QUALITY_DONE_BLOCKED");
    assert.equal((await f.state.getTaskRun(f.task.id)).status, "ready_for_review");
    await f.state.workspaceMutations.end(token);
    const fresh = await f.gate();
    await f.state.assertQualityGateCurrent(fresh);
    assert.equal((await f.state.completeTaskRun(f.task.id, fresh.id)).status, "done");
  } finally { await f.close(); }
});

test("an older gate and a late Pause cannot overwrite current task status", async () => {
  const f = await fixture();
  try {
    const old = await f.gate();
    await f.gate({ status: "failed", testsPassed: false });
    const prior = await f.state.applyQualityGateStatus(old, "ready_for_review");
    assert.equal(prior.status, "ready_for_review");
    await f.state.setTaskRunStatus(f.task.id, "running");
    await f.state.setTaskRunStatus(f.task.id, "paused");
    const failed = await f.state.getLatestQualityGateResult(f.task.id);
    const paused = await f.state.applyQualityGateStatus(failed, "quality_failed");
    assert.equal(paused.status, "paused");
    assert.equal((await f.state.getTaskRun(f.task.id)).status, "paused");
  } finally { await f.close(); }
});

test("legacy claimed checks fail closed while a plain answer gate remains compatible", async () => {
  const f = await fixture();
  try {
    const base = { id: "legacy-check", taskRunId: f.task.id, status: "passed", testsPassed: true,
      knownRisks: [], evidenceArtifactIds: [], createdAt: new Date().toISOString() };
    await f.state.createQualityGateResult(base);
    await assert.rejects(f.state.assertQualityGateCurrent(base), error => error.code === "QUALITY_DONE_BLOCKED");
    const { testsPassed: _tests, ...answer } = base;
    answer.id = "legacy-answer";
    await f.state.createQualityGateResult(answer);
    await f.state.assertQualityGateCurrent(answer);
  } finally { await f.close(); }
});

test("a new failed checker invalidates a stored passing gate without any file edit", async () => {
  const f = await fixture();
  try {
    const gate = await f.gate();
    const step = await f.state.createStep({ taskRunId: f.task.id, index: 0, kind: "test", title: "new check", status: "running" });
    const checkpoint = await f.state.createCheckpoint({ taskRunId: f.task.id, stepId: step.id, reason: "before_shell", stateRef: "{}", summary: "check" });
    const approval = await f.state.createApproval({ taskRunId: f.task.id, checkpointId: checkpoint.id, actionType: "shell", status: "approved",
      actionSummary: "node --test", proposedAction: { type: "shell", command: "node", args: ["--test"] } });
    await f.state.claimApprovalExecution(approval.id, approval.actionRevision, "new-check-token");
    const run = await f.state.validationRuns.begin({ taskRunId: f.task.id, stepId: step.id, approvalId: approval.id,
      workspaceKey: gate.validationState.workspaceKey, checkerId: "node-test", kinds: ["test"],
      startFingerprint: gate.validationState.fingerprint, startGeneration: 0 });
    await f.state.validationRuns.finish(run.id, { status: "failed", exitCode: 1,
      finishFingerprint: gate.validationState.fingerprint, finishGeneration: 0 });
    await assert.rejects(f.state.assertQualityGateCurrent(gate), error => error.code === "QUALITY_DONE_BLOCKED");
    const stored = await f.state.createQualityGateResult({ ...gate, id: "late-passing-gate" });
    assert.equal(stored.status, "warning");
    assert.equal(stored.testsPassed, undefined);
    await assert.rejects(f.state.completeTaskRun(f.task.id, gate.id), error => error.code === "QUALITY_DONE_BLOCKED");
  } finally { await f.close(); }
});

const clockRollbackGates = async (f) => {
  const passed = await f.gate({ createdAt: "2030-01-01T00:00:00.000Z" });
  const warning = await f.gate({ status: "warning", buildPassed: undefined,
    knownRisks: ["Required build check has not run"], createdAt: "2020-01-01T00:00:00.000Z" });
  assert.deepEqual(warning.validationState, passed.validationState);
  return { passed, warning };
};

test("gate latest and history follow insertion order after clock rollback", async () => {
  const f = await fixture();
  try {
    const { passed, warning } = await clockRollbackGates(f);
    assert.equal((await f.state.getLatestQualityGateResult(f.task.id)).id, warning.id);
    const history = await f.state.listQualityGateResults(f.task.id);
    assert.deepEqual(history.map(gate => gate.id), [passed.id, warning.id]);
    assert.deepEqual(history.map(gate => gate.createdAt), [passed.createdAt, warning.createdAt]);
  } finally { await f.close(); }
});

test("clock rollback cannot let an older passing gate change task status", async () => {
  const f = await fixture();
  try {
    const { passed } = await clockRollbackGates(f);
    await f.state.setTaskRunStatus(f.task.id, "running");
    const task = await f.state.applyQualityGateStatus(passed, "ready_for_review");
    assert.equal(task.status, "running");
  } finally { await f.close(); }
});

test("clock rollback cannot bypass explicit risk approval through an older passing gate", async () => {
  const f = await fixture();
  try {
    const { passed, warning } = await clockRollbackGates(f);
    await assert.rejects(f.state.completeTaskRun(f.task.id, passed.id), error => error.code === "QUALITY_DONE_BLOCKED");
    await assert.rejects(f.state.completeTaskRun(f.task.id, warning.id), error => error.code === "QUALITY_DONE_BLOCKED");
    assert.equal((await f.state.getTaskRun(f.task.id)).status, "ready_for_review");
  } finally { await f.close(); }
});

test("repair reservation uses the current warning after clock rollback", async () => {
  const f = await fixture();
  try {
    const { warning } = await clockRollbackGates(f);
    const reservation = await f.state.repairAttempts.reserve({ taskRunId: f.task.id,
      qualityGateId: warning.id, maxAttempts: 1 });
    assert.equal(reservation.reserved, true);
    assert.equal(reservation.attempt.qualityGateId, warning.id);
  } finally { await f.close(); }
});
