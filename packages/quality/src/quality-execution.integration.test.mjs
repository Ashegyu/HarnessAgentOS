import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskRunCompletionService } from "@harness/core";
import { openDb, closeDb, LocalStateService, FilesystemArtifactStore } from "@harness/storage";
import { RunnerService, ShellRunner } from "@harness/runners";
import { QualityEvaluator } from "./quality-evaluator.ts";
import { RepairLoopService } from "./repair-loop-service.ts";
import { applyMigrations } from "../../storage/src/migrations.ts";

const fixture = async t => {
  const root = mkdtempSync(join(tmpdir(), "harness-quality-execution-"));
  const target = join(root, "project");
  mkdirSync(target);
  writeFileSync(join(target, "source.txt"), "old");
  writeFileSync(join(target, "source.test.cjs"), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); const fs=require("node:fs"); test("source is valid",()=>assert.equal(fs.readFileSync("source.txt","utf8"),"good"));\n');
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "actual quality execution", targetDir: target });
  const task = await state.createTaskRun({ threadId: thread.id, targetDir: target, userRequest: "코드를 수정하고 테스트해줘", status: "waiting_for_approval" });
  const shell = new ShellRunner();
  const runner = new RunnerService({ state, artifactStore: new FilesystemArtifactStore({ rootDir: join(root, "artifacts") }),
    // The outer node:test context is private runner IPC, not the child's
    // execution environment. A standalone checker must report its real exit.
    shellRunner: { run: input => shell.run({ ...input, env: { NODE_TEST_CONTEXT: undefined } }) },
  });
  const execute = async details => {
    const step = await state.createStep({ taskRunId: task.id, index: (await state.listStepsByTaskRun(task.id)).length,
      kind: "approval", title: "reviewed action", status: "pending" });
    const checkpoint = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "approved fixture" });
    const approval = await state.createApproval({ taskRunId: task.id, checkpointId: checkpoint.id,
      actionType: details.type, actionSummary: "approved fixture", status: "approved", proposedAction: details });
    return runner.executeApproved(approval.id);
  };
  const evaluator = new QualityEvaluator({ state });
  const completion = new TaskRunCompletionService({ state });
  t.after(() => { closeDb(db); rmSync(root, { recursive: true, force: true }); });
  return { root, target, db, state, task, execute, evaluator, completion };
};

test("a confirmed failed checker remains failed in history but does not strand a later verified repair", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] }), /exited/);
  const failed = (await f.state.listApprovalsByTaskRun(f.task.id)).find(a => a.actionType === "shell");
  assert.equal(failed.executionState, "failed");
  assert.equal(failed.status, "executed");
  const badGate = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.equal(badGate.testsPassed, false);
  await f.completion.applyQualityGateResult(badGate);
  await assert.rejects(f.completion.markDone({ taskRunId: f.task.id }), /failed/);
  await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "old", after: "good" } });
  await f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] });
  const repaired = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.equal(repaired.status, "passed");
  await f.completion.applyQualityGateResult(repaired);
  assert.equal((await f.completion.markDone({ taskRunId: f.task.id })).status, "done");
  assert.equal((await f.state.getApproval(failed.id)).executionState, "failed");
  assert.ok((await f.state.listStepsByTaskRun(f.task.id)).some(s => s.kind === "test" && s.status === "failed"));
  await assert.rejects(new RunnerService({ state: f.state, artifactStore: new FilesystemArtifactStore({ rootDir: join(f.root, "replay") }) }).executeApproved(failed.id), /approved|claim/i);
});

for (const mutatesSource of [false, true]) {
  test(`unverified or mutating command failures still require result review (mutates=${mutatesSource})`, async t => {
    const f = await fixture(t);
    let details;
    if (mutatesSource) {
      writeFileSync(join(f.target, "mutating.test.mjs"), 'import {test} from "node:test"; import {writeFileSync} from "node:fs"; test("mutation",()=>{writeFileSync("source.txt","changed");throw new Error("failed after edit")});');
      details = { type: "shell", command: "node", args: ["--test", "mutating.test.mjs"] };
    } else details = { type: "shell", command: "node", args: ["-e", "process.exit(1)"] };
    await assert.rejects(f.execute(details), /exited/);
    const approval = (await f.state.listApprovalsByTaskRun(f.task.id))[0];
    assert.equal(approval.executionState, "uncertain");
    assert.notEqual(approval.status, "executed");
  });
}

test("legacy execution-state migration preserves approval row order, consent, events and validation references", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] }), /exited/);
  const source = (await f.state.listApprovalsByTaskRun(f.task.id))[0];
  // Build the v43 column constraint, retaining real child execution evidence.
  f.db.exec("DROP TRIGGER approval_events_insert; DROP TRIGGER approval_events_update;");
  f.db.exec("ALTER TABLE approvals DROP COLUMN execution_state;");
  f.db.exec("ALTER TABLE approvals ADD COLUMN execution_state TEXT CHECK(execution_state IN ('running','succeeded','uncertain'));");
  f.db.prepare("UPDATE approvals SET execution_state='uncertain',status='approved' WHERE id=?").run(source.id);
  f.db.prepare("UPDATE schema_meta SET value='43' WHERE key='schema_version'").run();
  const before = f.db.prepare("SELECT rowid,* FROM approvals ORDER BY rowid").all();
  const events = f.db.prepare("SELECT * FROM approval_events ORDER BY id").all();
  const runs = await f.state.validationRuns.listByTaskRun(f.task.id);
  applyMigrations(f.db); applyMigrations(f.db);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM approvals ORDER BY rowid").all(), before);
  assert.deepEqual(f.db.prepare("SELECT * FROM approval_events ORDER BY id").all(), events);
  assert.deepEqual(await f.state.validationRuns.listByTaskRun(f.task.id), runs);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.db.pragma("foreign_keys", { simple: true }), 1);
  await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] }), /exited/);
  const latest = (await f.state.approvals.listByTaskRun(f.task.id, "execution")).at(-1);
  assert.equal(latest.executionState, "failed");
  assert.equal(latest.status, "executed");
  assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM approval_events").get().n > events.length);
});

for (const differentChecker of [false, true]) {
  test(`repair signatures use actual failed checker identity across fresh artifacts (${differentChecker ? "different" : "same"} checker)`, async t => {
    const f = await fixture(t);
    await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "old", after: "bad" } });
    if (differentChecker) writeFileSync(join(f.target, "other.test.cjs"), readFileSync(join(f.target, "source.test.cjs")));
    let modelCalls = 0;
    const repair = new RepairLoopService({ state: f.state, completion: f.completion, maxAttempts: 4,
      agentPlanning: { generatePlan: async () => { modelCalls++; throw new Error("fixture planner stopped"); } } });
    await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] }), /exited|failed/i);
    const first = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(first.testsPassed, false);
    await assert.rejects(repair.createRepairPlan({ taskRunId: f.task.id }), /fixture planner stopped/);
    assert.equal(modelCalls, 1);
    // Include a revision change: a failed repair must not reset the repeat guard.
    if (!differentChecker) await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "bad", after: "still bad" } });
    await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", differentChecker ? "other.test.cjs" : "source.test.cjs"] }), /exited|failed/i);
    const second = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(second.testsPassed, false);
    assert.deepEqual(second.knownRisks, first.knownRisks);
    const runs = await f.state.validationRuns.listByTaskRun(f.task.id);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].artifactId, runs[1].artifactId);
    if (!differentChecker) assert.notEqual(runs[0].startFingerprint, runs[1].startFingerprint);
    assert.ok(first.evidenceArtifactIds.includes(runs[0].artifactId));
    assert.ok(second.evidenceArtifactIds.includes(runs[1].artifactId));
    await assert.rejects(repair.createRepairPlan({ taskRunId: f.task.id }), differentChecker ? /fixture planner stopped/ : /same quality failure signature/);
    assert.equal(modelCalls, differentChecker ? 2 : 1);
    assert.equal((await f.state.repairAttempts.listByTaskRun(f.task.id)).length, differentChecker ? 2 : 1);
  });
}

test("actual echo cannot satisfy checks; a real Node test validates the changed files and expires after an edit", async t => {
  const f = await fixture(t);
  await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "old", after: "good" } });
  await f.execute({ type: "shell", command: "node", args: ["-e", 'console.log("test build smoke")'] });
  const printed = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true, requireBuild: true, requireSmoke: true });
  assert.notEqual(printed.status, "passed");
  assert.equal(printed.testsPassed, undefined);
  assert.equal(printed.buildPassed, undefined);
  assert.equal(printed.smokePassed, undefined);
  await f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] });
  const checked = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.equal(checked.status, "passed");
  assert.equal(checked.testsPassed, true);
  assert.ok(checked.validationState?.fingerprint);
  await f.completion.applyQualityGateResult(checked);
  writeFileSync(join(f.target, "source.txt"), "evil");
  await assert.rejects(f.completion.markDone({ taskRunId: f.task.id }), /QUALITY_DONE_BLOCKED|changed|current|stale|변경|최신/i);
  assert.notEqual((await f.state.getTaskRun(f.task.id)).status, "done");
  const stale = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.notEqual(stale.status, "passed");
  assert.equal(stale.testsPassed, undefined);
});

test("a real failed Node test is superseded only by the same checker rerun against the fixed revision", async t => {
  const f = await fixture(t);
  await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "old", after: "bad" } });
  await assert.rejects(f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] }), /exited|failed/i);
  const failed = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.equal(failed.status, "failed");
  assert.equal(failed.testsPassed, false);
  await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "bad", after: "good" } });
  const untestedFix = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.notEqual(untestedFix.status, "passed");
  await f.execute({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] });
  const passed = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.equal(passed.status, "passed");
  assert.equal(passed.testsPassed, true);
  const runs = (await f.state.validationRuns.listByTaskRun(f.task.id)).filter(run => run.kinds.includes("test"));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].checkerId, runs[1].checkerId);
  assert.ok(runs[1].sequence > runs[0].sequence);
  assert.notEqual(runs[0].startFingerprint, runs[1].startFingerprint);
});

test("an actual npm test script that only prints checker names stays unverified", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.target, "package.json"), JSON.stringify({ name: "quality-fixture", version: "1.0.0", scripts: { test: "echo test build smoke" } }));
  await f.execute({ type: "file_write", filePatch: { path: "source.txt", before: "old", after: "good" } });
  await f.execute({ type: "shell", command: "npm test" });
  const gate = await f.evaluator.evaluate({ taskRunId: f.task.id, requireTests: true });
  assert.notEqual(gate.status, "passed");
  assert.equal(gate.testsPassed, undefined);
  assert.deepEqual((await f.state.validationRuns.listByTaskRun(f.task.id))[0].kinds, []);
  assert.equal(readFileSync(join(f.target, "source.txt"), "utf8"), "good");
});
