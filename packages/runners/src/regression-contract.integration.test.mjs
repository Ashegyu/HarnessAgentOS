import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, LocalStateService, FilesystemArtifactStore } from "@harness/storage";
import { ConversationService, validateProposedActionDetails } from "@harness/core";
import { QualityEvaluator } from "@harness/quality";
import { RunnerService } from "./runner-service.ts";

const source = `using System.Text.Json;
public static class Api {
 public static int Value()=>7;
 public static async Task<string> GetAsync(string key){ArgumentNullException.ThrowIfNull(key);await Task.Yield();return key;}
 public static string Read(string text){using var d=JsonDocument.Parse(text);if(d.RootElement.ValueKind!=JsonValueKind.Object)throw new InvalidDataException();return text;}
 public sealed record Snapshot(long Revision,IReadOnlyDictionary<string,int> Values);
 public static Snapshot Capture()=>new(0,new System.Collections.ObjectModel.ReadOnlyDictionary<string,int>(new Dictionary<string,int>()));
}`;
const validTest = `internal static class Program{static void Main(){if(Api.Value()!=7)throw new Exception("original regression");}}`;

async function fixture(candidate = source, verification = validTest, shellRunner) {
  const root = await mkdtemp(join(tmpdir(), "hgos-regression-contract-"));
  const project = join(root, "project"), reference = join(root, "reference");
  await mkdir(project); await mkdir(reference);
  await writeFile(join(project, "Api.cs"), candidate); await writeFile(join(project, "Verification.cs"), verification);
  await writeFile(join(reference, "Api.cs"), source);
  const db = openDb({ filePath: join(root, "state.sqlite") }), state = new LocalStateService(db);
  const thread = await state.createThread({ title: "regression", targetDir: project });
  const task = await state.createTaskRun({ threadId: thread.id, targetDir: project, userRequest: "C# 코드를 수정하고 검사해줘", intent: "change" });
  const runner = new RunnerService({ state, artifactStore: new FilesystemArtifactStore({ rootDir: join(root, "artifacts") }), ...(shellRunner ? { shellRunner } : {}) });
  const conversation = new ConversationService({ state, pathExists: () => true });
  const register = () => runner.registerRegressionContract({ taskRunId: task.id, title: "API regressions", referenceDir: reference,
    sourcePaths: ["Api.cs"], sharedPaths: [], verificationPaths: ["Verification.cs"], manualConfirmation: true });
  const approve = a => conversation.approve({ approvalId: a.id, expectedRevision: a.actionRevision, manualConfirmation: true });
  const check = async contract => { const approval = await runner.prepareRegressionCheck({ taskRunId: task.id, contractId: contract.id }); await approve(approval); return runner.executeApproved(approval.id); };
  const edit = async (path, after) => {
    const step = await state.createStep({ taskRunId: task.id, index: (await state.listStepsByTaskRun(task.id)).length, kind: "approval", title: "edit", status: "pending" });
    const cp = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "repair" });
    const a = await state.createApproval({ taskRunId: task.id, checkpointId: cp.id, actionType: "file_write", actionSummary: "repair file",
      proposedAction: { type: "file_write", filePatch: { path, after } } });
    await approve(a); return runner.executeApproved(a.id);
  };
  return { root, project, reference, db, state, task, runner, register, approve, check, edit,
    cleanup: async () => { await runner.shutdown(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("host regression check metadata survives validation and cannot accompany arbitrary commands", () => {
  const details = { type: "shell", command: "dotnet", args: [], regressionCheck: { contractId: "reg_fixture", inputFingerprint: "a".repeat(64) } };
  assert.deepEqual(validateProposedActionDetails(details, "shell").details?.regressionCheck, details.regressionCheck);
  assert.equal(validateProposedActionDetails({ ...details, command: "node" }, "shell").ok, false);
});

test("registration invalidates old quality, requires explicit trust, and never starts a process", async () => {
  let calls = 0; const f = await fixture(source, validTest, { run: async () => { calls++; throw new Error("must not execute"); } });
  try {
    await assert.rejects(f.runner.registerRegressionContract({ taskRunId: f.task.id, title: "no trust", referenceDir: f.reference,
      sourcePaths: ["Api.cs"], sharedPaths: [], verificationPaths: ["Verification.cs"], manualConfirmation: false }), /confirm|trust|확인/i);
    const contract = await f.register();
    assert.equal(contract.protected, false);
    assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id })).length, 1);
    const gate = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(gate.status, "not_run");
    assert.ok(gate.knownRisks.some(x => /regression|회귀/i.test(x)));
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("a regression approval refuses changed inputs before spawning and remains manual", async () => {
  let calls = 0; const f = await fixture(source, validTest, { run: async () => { calls++; throw new Error("must not execute"); } });
  try {
    const contract = await f.register();
    const approval = await f.runner.prepareRegressionCheck({ taskRunId: f.task.id, contractId: contract.id });
    await assert.rejects(f.runner.executeApproved(approval.id), /approv/i);
    await f.approve(approval);
    await writeFile(join(f.project, "Api.cs"), source + "\n// changed after approval");
    await assert.rejects(f.runner.executeApproved(approval.id), /changed|stale|변경/i);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

const real = { skip: process.env.HARNESS_DOTNET_INTEGRATION !== "1", timeout: 120_000 };
test("real C# controls preserve accepted tests across repair and block weakened writes and deletes", real, async () => {
  const f = await fixture(source.replace("Value()=>7", "Value()=>0"));
  try {
    const contract = await f.register();
    await assert.rejects(f.check(contract), /exited|failed|실패/i);
    assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, true);
    await assert.rejects(f.edit("Verification.cs", "internal static class Program{static void Main(){}}"), /protected|보호/i);
    assert.equal(await readFile(join(f.project, "Verification.cs"), "utf8"), validTest);
    await f.edit("Api.cs", source);
    await f.check(contract);
    const gate = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireBuild: false, requireTests: true, requireSmoke: false });
    assert.notEqual(gate.status, "not_run"); assert.notEqual(gate.status, "failed");
    // A direct write bypassing the file runner cannot manufacture a current pass.
    await writeFile(join(f.project, "Verification.cs"), "internal static class Program{static void Main(){}}");
    await assert.rejects(f.runner.prepareRegressionCheck({ taskRunId: f.task.id, contractId: contract.id }), /protected|보호/i);
    const stale = await new QualityEvaluator({ state: f.state }).evaluate({ taskRunId: f.task.id, requireTests: true });
    assert.equal(stale.status, "not_run");
    await f.edit("Verification.cs", validTest); // Exact restoration is allowed.
    await f.check(contract);
    const step = await f.state.createStep({ taskRunId: f.task.id, index: 100, kind: "approval", title: "delete", status: "pending" });
    const cp = await f.state.createCheckpoint({ taskRunId: f.task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "delete" });
    const a = await f.state.createApproval({ taskRunId: f.task.id, checkpointId: cp.id, actionType: "file_delete", actionSummary: "delete tests",
      proposedAction: { type: "file_delete", fileDelete: { path: "Verification.cs" } } });
    await f.approve(a); await assert.rejects(f.runner.executeApproved(a.id), /protected|보호/i);
  } finally { await f.cleanup(); }
});

for (const [name, program] of [
  ["async exception", `internal static class Program{static void Main(){try{_ = Api.GetAsync(null!);}catch(ArgumentNullException){return;}throw new Exception("Expected synchronous exception");}}`],
  ["trailing CR", `internal static class Program{static void Main(){try{Api.Read("{}"+(char)13);}catch(InvalidDataException){return;}throw new Exception("Expected invalid JSON");}}`],
  ["snapshot equality", `internal static class Program{static void Main(){if(!Equals(Api.Capture(),Api.Capture()))throw new Exception("Expected record equality");}}`],
]) {
  test(`real normal-reference execution rejects a false-positive ${name} assertion`, real, async () => {
    const f = await fixture(source, program);
    try {
      const contract = await f.register();
      await assert.rejects(f.check(contract), /exited|failed|실패/i);
      assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, false);
      const artifacts = await f.state.listArtifactsByTaskRun(f.task.id);
      assert.ok(artifacts.some(a => a.summary?.includes("reference")), "reference execution must be distinguished from candidate failure");
      // The false assertion is not frozen; a corrected regression is editable.
      await f.edit("Verification.cs", validTest);
      await f.check(contract);
      assert.equal((await f.runner.listRegressionContracts({ taskRunId: f.task.id }))[0].protected, true);
    } finally { await f.cleanup(); }
  });
}
