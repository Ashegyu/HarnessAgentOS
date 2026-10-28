import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, closeDb, LocalStateService, FilesystemArtifactStore } from "@harness/storage";
import { DEFAULT_RUNNER_TEST_TIMEOUT_MS } from "@harness/core";
import { RunnerService } from "./runner-service.ts";

const fixture = async t => {
  const root = mkdtempSync(join(tmpdir(), "harness-validation-runner-"));
  const target = join(root, "project");
  mkdirSync(target);
  writeFileSync(join(target, "source.txt"), "original");
  writeFileSync(join(target, "source.test.cjs"), 'require("node:test")("works", () => require("node:assert/strict").equal(1, 1));\n');
  const db = openDb({ filePath: ":memory:" });
  t.after(() => { closeDb(db); rmSync(root, { recursive: true, force: true }); });
  const state = new LocalStateService(db);
  const store = new FilesystemArtifactStore({ rootDir: join(root, "artifacts") });
  const thread = await state.createThread({ title: "validation", targetDir: target });
  const canonical = await realpath(target);
  const workspaceKey = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const approve = async (action, taskRunId) => {
    const task = taskRunId ? await state.getTaskRun(taskRunId) : await state.createTaskRun({
      threadId: thread.id, userRequest: "코드를 수정하고 검사해줘", targetDir: target, status: "waiting_for_approval",
    });
    const step = await state.createStep({ taskRunId: task.id, index: (await state.listStepsByTaskRun(task.id)).length,
      kind: "approval", title: "Execute approved action", status: "pending" });
    const checkpoint = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "approved" });
    const approval = await state.createApproval({ taskRunId: task.id, checkpointId: checkpoint.id,
      actionType: action.type, actionSummary: "approved test fixture", status: "approved", proposedAction: action });
    return { task, approval };
  };
  return { state, target, workspaceKey, approve, store };
};
const success = input => ({ command: input.command, cwd: input.cwd, exitCode: 0, stdout: "checker finished", stderr: "", durationMs: 1 });
const listRuns = async (f, task) => f.state.validationRuns ? f.state.validationRuns.listByTaskRun(task.id) : [];

test("echo containing npm test is executed as a shell and never gets a checker kind", async t => {
  const f = await fixture(t);
  const { task, approval } = await f.approve({ type: "shell", command: 'echo "npm test build smoke"' });
  let testCalls = 0;
  const runner = new RunnerService({ state: f.state, artifactStore: f.store,
    shellRunner: { run: async input => success(input) },
    testRunner: { run: async input => { testCalls += 1; return { ...success(input), passed: true }; } },
  });
  await runner.executeApproved(approval.id);
  assert.equal(testCalls, 0, "words printed by echo cannot select TestRunner");
  const runs = await listRuns(f, task);
  assert.equal(runs.length, 1, "every approved shell retains host execution provenance");
  assert.deepEqual(runs[0].kinds, []);
  assert.equal(runs[0].exitCode, 0);
  assert.equal(runs[0].status, "completed");
});

test("an unverified npm test wrapper keeps its test timeout without becoming quality evidence", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.target, "package.json"), JSON.stringify({ scripts: {
    test: "node prepare.cjs && node --test source.test.cjs",
  } }));
  const { task, approval } = await f.approve({ type: "shell", command: "npm test" });
  let observed;
  const runner = new RunnerService({ state: f.state, artifactStore: f.store,
    shellRunner: { run: async () => { throw new Error("the legacy test driver must retain its timeout"); } },
    testRunner: { run: async input => { observed = input; return { ...success(input), passed: true }; } },
  });
  const result = await runner.executeApproved(approval.id);
  assert.equal(observed.timeoutMs, DEFAULT_RUNNER_TEST_TIMEOUT_MS);
  const [run] = await listRuns(f, task);
  assert.deepEqual(run.kinds, [], "a routing hint cannot turn a custom wrapper into a proven checker");
  assert.equal((await f.state.listStepsByTaskRun(task.id)).find(step => step.id === result.stepId).kind, "shell");
  assert.equal((await f.state.listArtifactsByTaskRun(task.id)).some(a => a.kind === "test_result"), false);
  assert.equal((await f.state.workspaceMutations.get(f.workspaceKey)).generation, 2);
});

test("an actual structured checker records approval, artifact and unchanged input revision", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.target, "source.test.cjs"), 'require("node:test")("works", () => require("node:assert/strict").equal(1, 1));\n');
  const { task, approval } = await f.approve({ type: "shell", command: "node", args: ["--test", "source.test.cjs"] });
  const result = await new RunnerService({ state: f.state, artifactStore: f.store }).executeApproved(approval.id);
  const runs = await listRuns(f, task);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.approvalId, approval.id);
  assert.equal(run.stepId, result.stepId);
  assert.deepEqual(run.kinds, ["test"]);
  assert.equal(run.exitCode, 0);
  assert.equal(run.status, "completed");
  assert.ok(run.startFingerprint);
  assert.equal(run.finishFingerprint, run.startFingerprint);
  assert.equal(run.finishGeneration, run.startGeneration);
  assert.ok(result.artifactIds.includes(run.artifactId));
  assert.ok((await f.state.listArtifactsByTaskRun(task.id)).some(a => a.id === run.artifactId && a.stepId === run.stepId));
});

test("a checker that changes its source cannot validate its starting revision", async t => {
  const f = await fixture(t);
  const { task, approval } = await f.approve({ type: "shell", command: "dotnet", args: ["test", "fixture.csproj"] });
  const runner = new RunnerService({ state: f.state, artifactStore: f.store, testRunner: { run: async input => {
    writeFileSync(join(f.target, "source.txt"), "modified");
    return { ...success(input), passed: true };
  } } });
  await runner.executeApproved(approval.id);
  const [run] = await listRuns(f, task);
  assert.ok(run, "the host must record the checker execution");
  assert.notEqual(run.startFingerprint, run.finishFingerprint);
  assert.match(run.reason ?? "", /revision|changed|input/i);
});

test("an unknown shell owns a workspace mutation until its actual execution settles", async t => {
  const f = await fixture(t);
  const { task, approval } = await f.approve({ type: "shell", command: "echo", args: ["ordinary command"] });
  let observed;
  const runner = new RunnerService({ state: f.state, artifactStore: f.store, shellRunner: { run: async input => {
    observed = await f.state.workspaceMutations?.get(f.workspaceKey);
    return success(input);
  } } });
  await runner.executeApproved(approval.id);
  assert.equal(observed?.activeMutations, 1);
  const after = await f.state.workspaceMutations.get(f.workspaceKey);
  assert.equal(after.activeMutations, 0);
  assert.equal(after.generation, 2);
  assert.deepEqual((await listRuns(f, task))[0].kinds, []);
});

test("a file change and restoration during a checker advances the shared workspace generation", async t => {
  const f = await fixture(t);
  const { task, approval } = await f.approve({ type: "shell", command: "dotnet", args: ["test", "fixture.csproj"] });
  const changes = [];
  for (const [before, after] of [["original", "temporary"], ["temporary", "original"]]) {
    changes.push(await f.approve({ type: "file_write", filePatch: { path: "source.txt", before, after } }));
  }
  const mutations = new RunnerService({ state: f.state, artifactStore: f.store });
  const checker = new RunnerService({ state: f.state, artifactStore: f.store, testRunner: { run: async input => {
    for (const change of changes) await mutations.executeApproved(change.approval.id);
    return { ...success(input), passed: true };
  } } });
  await checker.executeApproved(approval.id);
  assert.equal(readFileSync(join(f.target, "source.txt"), "utf8"), "original");
  const [run] = await listRuns(f, task);
  assert.ok(run);
  assert.ok(run.finishGeneration > run.startGeneration, "restoring bytes cannot restore host mutation history");
  assert.match(run.reason ?? "", /generation|mutation|changed/i);
});

test("failed and cancelled checker attempts retain terminal host provenance", async t => {
  const f = await fixture(t);
  for (const cancelled of [false, true]) {
    const { task, approval } = await f.approve({ type: "shell", command: "dotnet", args: ["test", "fixture.csproj"] });
    const runner = new RunnerService({ state: f.state, artifactStore: f.store, testRunner: { run: async input => {
      if (cancelled) throw Object.assign(new Error("cancelled by fixture"), { code: "RUNNER_CANCELLED" });
      return { ...success(input), passed: false, exitCode: 1 };
    } } });
    await assert.rejects(runner.executeApproved(approval.id));
    const [run] = await listRuns(f, task);
    assert.ok(run);
    assert.equal(run.status, cancelled ? "cancelled" : "failed");
    if (!cancelled) { assert.equal(run.exitCode, 1); assert.ok(run.artifactId); }
    assert.equal((await f.state.getApproval(approval.id)).executionState, cancelled ? "uncertain" : "failed",
      "a proven nonzero checker exit is a confirmed failure; cancellation without process proof remains uncertain");
  }
});
