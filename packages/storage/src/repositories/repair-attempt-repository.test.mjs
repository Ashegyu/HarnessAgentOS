import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-repair-attempt-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRunAndGate = async (state) => {
  const thread = await state.createThread({ title: "repair" });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "fix failing tests",
    targetDir: process.cwd(),
  });
  await state.createQualityGateResult({
    id: "qg-1",
    taskRunId: taskRun.id,
    status: "failed",
    testsPassed: false,
    knownRisks: ["tests failed"],
    evidenceArtifactIds: ["art-log"],
    createdAt: "2026-05-16T00:00:00.000Z",
  });
  return { taskRun };
};

test("RepairAttemptRepository creates indexed attempts and updates approval ids", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRunAndGate(state);
    const first = await state.repairAttempts.create({
      taskRunId: taskRun.id,
      qualityGateId: "qg-1",
      failureSignature: "sig-1",
    });
    const second = await state.repairAttempts.create({
      taskRunId: taskRun.id,
      qualityGateId: "qg-1",
      failureSignature: "sig-2",
    });
    const prompt = await state.createArtifact({
      taskRunId: taskRun.id,
      kind: "log",
      title: "prompt",
      uri: "harness:test-prompt",
      summary: "prompt",
    });
    const invocation = await state.createAgentInvocation({
      taskRunId: taskRun.id,
      provider: "codex",
      model: "gpt-test",
      promptArtifactId: prompt.id,
    });
    assert.equal(first.attemptIndex, 0);
    assert.equal(second.attemptIndex, 1);
    const updated = await state.repairAttempts.update(first.id, {
      status: "waiting_for_approval",
      invocationId: invocation.id,
      generatedApprovalIds: ["apv-1", "apv-2"],
    });
    assert.equal(updated.status, "waiting_for_approval");
    assert.deepEqual(updated.generatedApprovalIds, ["apv-1", "apv-2"]);
    const rows = await state.repairAttempts.listByTaskRun(taskRun.id);
    assert.equal(rows.length, 2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

for (const column of ["known_risks_json", "evidence_artifact_ids_json", "tests_passed"]) {
  for (const corruptHistory of [false, true]) {
    test(`repair reservation fails closed for corrupt ${corruptHistory ? "historical" : "current"} ${column}`, async () => {
      const db = openDb({ filePath: ":memory:" });
      try {
        const state = new LocalStateService(db);
        const { taskRun } = await seedTaskRunAndGate(state);
        if (corruptHistory) {
          await state.repairAttempts.create({ taskRunId: taskRun.id, qualityGateId: "qg-1", failureSignature: "legacy" });
          await state.createQualityGateResult({ id: "new-gate", taskRunId: taskRun.id, status: "failed", testsPassed: false,
            knownRisks: ["different failure"], evidenceArtifactIds: [], createdAt: "2030" });
        }
        db.prepare(`UPDATE quality_gate_results SET ${column}=? WHERE id='qg-1'`).run(column === "tests_passed" ? 2 : '{"invalid":true}');
        const result = await state.repairAttempts.reserve({ taskRunId: taskRun.id, qualityGateId: corruptHistory ? "new-gate" : "qg-1", maxAttempts: 4 });
        assert.deepEqual(result, { reserved: false, reason: "unverifiable_failure" });
        assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id)).length, corruptHistory ? 1 : 0);
        assert.equal(db.inTransaction, false);
      } finally { closeDb(db); }
    });
  }
}

test("repair reservation derives its own signature and keeps max-attempt policy", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRunAndGate(state);
    const input = { taskRunId: taskRun.id, qualityGateId: "qg-1", maxAttempts: 3 };
    for (const maxAttempts of [-1, 0.5, NaN]) await assert.rejects(state.repairAttempts.reserve({ ...input, maxAttempts }), RangeError);
    assert.deepEqual(await state.repairAttempts.reserve({ ...input, maxAttempts: 0 }), { reserved: false, reason: "limit" });
    const first = await state.repairAttempts.reserve({ ...input, failureSignature: "caller-controlled" });
    assert.equal(first.reserved, true);
    assert.match(first.attempt.failureSignature, /^quality-v2:/);
    assert.deepEqual(await state.repairAttempts.reserve({ ...input, failureSignature: "different-caller-hash" }), { reserved: false, reason: "repeated_signature" });
    assert.deepEqual(await state.repairAttempts.reserve({ ...input, maxAttempts: 1 }), { reserved: false, reason: "limit" });
  } finally { closeDb(db); }
});

test("distinct exact gate failures remain repairable while not_run is supported", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRunAndGate(state);
    await state.repairAttempts.reserve({ taskRunId: taskRun.id, qualityGateId: "qg-1", maxAttempts: 5 });
    const patches = [{ knownRisks: ["different tests failed"] }, { status: "warning", testsPassed: undefined }, { status: "not_run", testsPassed: undefined }];
    for (const [i, patch] of patches.entries()) {
      const gate = await state.createQualityGateResult({ id: `gate-${i}`, taskRunId: taskRun.id, status: "failed", testsPassed: false,
        knownRisks: ["tests failed"], evidenceArtifactIds: [], createdAt: "2000", ...patch });
      assert.equal((await state.repairAttempts.reserve({ taskRunId: taskRun.id, qualityGateId: gate.id, maxAttempts: 5 })).reserved, true);
    }
    assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id)).length, 4);
  } finally { closeDb(db); }
});

const failedProof = async (state, taskRunId, checkerId, exitCode, kinds = ["test"]) => {
  await state.setTaskRunStatus(taskRunId, "running");
  const step = await state.createStep({ taskRunId, index: (await state.listStepsByTaskRun(taskRunId)).length,
    kind: "test", title: "host checker fixture", status: "running" });
  const checkpoint = await state.createCheckpoint({ taskRunId, stepId: step.id, reason: "before_shell", stateRef: "{}", summary: "fixture" });
  const approval = await state.createApproval({ taskRunId, checkpointId: checkpoint.id, actionType: "shell", actionSummary: "node --test",
    status: "approved", proposedAction: { type: "shell", command: "node", args: ["--test"] } });
  await state.claimApprovalExecution(approval.id, approval.actionRevision, "fixture-token");
  const run = await state.validationRuns.begin({ taskRunId, stepId: step.id, approvalId: approval.id,
    workspaceKey: "fixture-workspace", checkerId, kinds, startFingerprint: "fixture-revision", startGeneration: 0 });
  const artifact = await state.createArtifact({ taskRunId, stepId: step.id, kind: "test_result", title: "host checker result", uri: `harness:fixture/${run.id}` });
  await state.validationRuns.finish(run.id, { status: "failed", exitCode, artifactId: artifact.id,
    finishFingerprint: "fixture-revision", finishGeneration: 0 });
  return artifact.id;
};

for (const { name, firstProof = true, secondProof = true, checkerId = "node-test", exitCode = 1, kinds = ["test"], repeated = false } of [
  { name: "new artifact with the same checker", repeated: true },
  { name: "different checker", checkerId: "other-test" },
  { name: "different exit status", exitCode: 2 },
  { name: "different checker classification", kinds: ["test", "smoke"] },
  { name: "old gate without execution proof", firstProof: false, checkerId: "other-test", repeated: true },
  { name: "new gate without execution proof", secondProof: false, repeated: true },
  { name: "unverified checker classification", kinds: [], repeated: true },
]) {
  test(`repair compares each source gate's immutable proof: ${name}`, async () => {
    const db = openDb({ filePath: ":memory:" });
    try {
      const state = new LocalStateService(db);
      const { taskRun } = await seedTaskRunAndGate(state);
      const gate = { taskRunId: taskRun.id, status: "failed", testsPassed: false, knownRisks: ["tests failed"], createdAt: "2000" };
      const oldArtifact = firstProof ? await failedProof(state, taskRun.id, "node-test", 1) : "old-log";
      await state.createQualityGateResult({ ...gate, id: "old-gate", evidenceArtifactIds: [oldArtifact] });
      const old = await state.repairAttempts.create({ taskRunId: taskRun.id, qualityGateId: "old-gate", failureSignature: "legacy-v1", status: "stopped" });
      const newArtifact = secondProof ? await failedProof(state, taskRun.id, checkerId, exitCode, kinds) : "new-log";
      await state.createQualityGateResult({ ...gate, id: "new-gate", evidenceArtifactIds: [newArtifact, newArtifact] });
      const result = await state.repairAttempts.reserve({ taskRunId: taskRun.id, qualityGateId: "new-gate", maxAttempts: 3 });
      assert.equal(result.reserved, !repeated);
      if (repeated) assert.equal(result.reason, "repeated_signature");
      assert.equal((await state.repairAttempts.get(old.id)).failureSignature, "legacy-v1", "historical audit data is not rewritten");
      assert.equal((await state.repairAttempts.listByTaskRun(taskRun.id)).length, repeated ? 1 : 2);
    } finally { closeDb(db); }
  });
}

test("corrupt linked checker metadata blocks a repair instead of bypassing comparison", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    const { taskRun } = await seedTaskRunAndGate(state);
    const artifact = await failedProof(state, taskRun.id, "node-test", 1);
    await state.createQualityGateResult({ id: "new-gate", taskRunId: taskRun.id, status: "failed", testsPassed: false,
      knownRisks: ["tests failed"], evidenceArtifactIds: [artifact], createdAt: "2000" });
    db.prepare("UPDATE validation_runs SET kinds_json='invalid' WHERE artifact_id=?").run(artifact);
    assert.deepEqual(await state.repairAttempts.reserve({ taskRunId: taskRun.id, qualityGateId: "new-gate", maxAttempts: 3 }),
      { reserved: false, reason: "unverifiable_failure" });
    assert.deepEqual(await state.repairAttempts.listByTaskRun(taskRun.id), []);
  } finally { closeDb(db); }
});
