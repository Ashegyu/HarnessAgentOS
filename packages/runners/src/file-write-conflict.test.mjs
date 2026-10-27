import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService, FilesystemArtifactStore } from "@harness/storage";
import { ConversationService } from "@harness/core";
import { FileRunner } from "./file-runner.ts";
import { RunnerService } from "./runner-service.ts";

const workspace = t => {
  const root = mkdtempSync(join(tmpdir(), "hgos-file-conflict-"));
  const target = join(root, "target");
  mkdirSync(target);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, target };
};

// Hold the original read implementation until both contenders have captured the
// same baseline. A corrected writer may use a bound handle instead of this API.
const synchronizeOriginalReads = t => {
  const original = fsPromises.readFile;
  let readers = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  mock.method(fsPromises, "readFile", async (...args) => {
    const result = await original(...args);
    readers++;
    if (readers === 2) release();
    await barrier;
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
};

test("independent FileRunner instances cannot both overwrite the same approved preimage", async t => {
  const f = workspace(t);
  writeFileSync(join(f.target, "shared.txt"), "old");
  synchronizeOriginalReads(t);
  const results = await Promise.allSettled(["first", "second"].map(after => new FileRunner().run({
    targetDir: f.target, patch: { path: "shared.txt", before: "old", after },
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected")?.reason.code, "RUNNER_FILE_CONTENT_CHANGED");
  const winner = results.find(result => result.status === "fulfilled").value;
  assert.equal(readFileSync(join(f.target, "shared.txt"), "utf8"), winner.afterContent);
});

test("different approved patch executions cannot both replace the same context", async t => {
  const f = workspace(t);
  writeFileSync(join(f.target, "shared.txt"), "old\n");
  const db = openDb({ filePath: ":memory:" });
  t.after(() => closeDb(db));
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "patch race", targetDir: f.target });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "코드를 수정해줘", targetDir: f.target, status: "waiting_for_approval" });
  const step = await state.createStep({ taskRunId: task.id, index: 0, kind: "approval", title: "Review patch", status: "pending" });
  const cp = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "review" });
  const conversation = new ConversationService({ state, pathExists: async () => true });
  const artifactStore = new FilesystemArtifactStore({ rootDir: join(f.root, "artifacts") });
  const approvals = [];
  for (const after of ["first", "second"]) {
    const approval = await state.createApproval({ taskRunId: task.id, checkpointId: cp.id, actionType: "file_patch", actionSummary: "Replace old",
      proposedAction: { type: "file_patch", unifiedPatch: { path: "shared.txt", patch: `--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1 @@\n-old\n+${after}\n` } } });
    await conversation.approve({ approvalId: approval.id, expectedRevision: 1 });
    approvals.push(approval);
  }
  synchronizeOriginalReads(t);
  const results = await Promise.allSettled(approvals.map(approval => new RunnerService({ state, artifactStore }).executeApproved(approval.id)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected")?.reason.code, "RUNNER_FILE_CONTENT_CHANGED");
  assert.ok(["first\n", "second\n"].includes(readFileSync(join(f.target, "shared.txt"), "utf8")));
});

test("a bound multiply-linked target is rejected before any bytes are written", async t => {
  const f = workspace(t);
  const target = join(f.target, "shared.txt");
  writeFileSync(target, "original");
  const open = fsPromises.open;
  mock.method(fsPromises, "open", async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    mock.method(handle, "stat", async (...statArgs) => new Proxy(await stat(...statArgs), {
      get(object, key) { return key === "nlink" ? 2 : Reflect.get(object, key); },
    }));
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(new FileRunner().run({ targetDir: f.target, patch: { path: "shared.txt", after: "replacement" } }),
    error => error.code === "RUNNER_FILE_REGULAR_SINGLE_LINK_REQUIRED");
  assert.equal(readFileSync(target, "utf8"), "original");
});

test("a failed preimage check releases the per-file queue", async t => {
  const f = workspace(t);
  writeFileSync(join(f.target, "shared.txt"), "current");
  const bad = new FileRunner().run({ targetDir: f.target, patch: { path: "shared.txt", before: "stale", after: "bad" } });
  const good = new FileRunner().run({ targetDir: f.target, patch: { path: "shared.txt", before: "current", after: "good" } });
  const results = await Promise.allSettled([bad, good]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(readFileSync(join(f.target, "shared.txt"), "utf8"), "good");
});

test("different files retain parallel filesystem progress", async t => {
  const f = workspace(t);
  const mkdir = fsPromises.mkdir;
  let entered = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  mock.method(fsPromises, "mkdir", async (...args) => {
    entered++;
    if (entered === 2) release();
    await barrier;
    return mkdir(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  const results = await Promise.all(["a.txt", "b.txt"].map(path => new FileRunner().run({
    targetDir: f.target, patch: { path, after: path },
  })));
  assert.equal(entered, 2);
  assert.equal(results.length, 2);
});

test("case aliases share file ownership on Windows", { skip: process.platform !== "win32" }, async t => {
  const f = workspace(t);
  writeFileSync(join(f.target, "Shared.txt"), "old");
  synchronizeOriginalReads(t);
  const results = await Promise.allSettled(["Shared.txt", "SHARED.TXT"].map((path, index) => new FileRunner().run({
    targetDir: f.target, patch: { path, before: "old", after: `${index}` },
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected")?.reason.code, "RUNNER_FILE_CONTENT_CHANGED");
});

for (const after of ["", "짧음", "한글과 이모지 🙂 끝\n".repeat(500)]) {
  test(`bound writes preserve exact UTF-8 replacement (${Buffer.byteLength(after)} bytes)`, async t => {
    const f = workspace(t);
    writeFileSync(join(f.target, "shared.txt"), "original longer text\n");
    const result = await new FileRunner().run({ targetDir: f.target,
      patch: { path: "shared.txt", before: "original longer text\n", after } });
    assert.equal(readFileSync(result.path, "utf8"), after);
    assert.equal(result.beforeContent, "original longer text\n");
    assert.equal(result.bytesWritten, Buffer.byteLength(after));
  });
}

for (const kind of ["file_write", "file_patch"]) {
  test(`cancelling a queued ${kind} settles before the current file owner releases`, async t => {
    const f = workspace(t);
    const target = join(f.target, "shared.txt");
    writeFileSync(target, "old\n");
    const db = openDb({ filePath: ":memory:" });
    t.after(() => closeDb(db));
    const state = new LocalStateService(db);
    const thread = await state.createThread({ title: "cancel queue", targetDir: f.target });
    const artifactStore = new FilesystemArtifactStore({ rootDir: join(f.root, "artifacts") });
    const conversation = new ConversationService({ state, pathExists: async () => true });
    const create = async (actionType, after) => {
      const task = await state.createTaskRun({ threadId: thread.id, userRequest: "코드를 수정해줘", targetDir: f.target, status: "waiting_for_approval" });
      const step = await state.createStep({ taskRunId: task.id, index: 0, kind: "approval", title: "Review", status: "pending" });
      const cp = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "review" });
      const proposedAction = actionType === "file_write"
        ? { type: "file_write", filePatch: { path: "shared.txt", after } }
        : { type: "file_patch", unifiedPatch: { path: "shared.txt", patch: `--- a/shared.txt\n+++ b/shared.txt\n@@ -1 +1 @@\n-old\n+${after.trim()}\n` } };
      const approval = await state.createApproval({ taskRunId: task.id, checkpointId: cp.id, actionType, actionSummary: "replace", proposedAction });
      await conversation.approve({ approvalId: approval.id, expectedRevision: 1 });
      return { task, approval, runner: new RunnerService({ state, artifactStore }) };
    };
    const first = await create("file_write", "first\n");
    const second = await create(kind, "second\n");
    let releaseFirst;
    let firstEntered;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const entered = new Promise(resolve => { firstEntered = resolve; });
    const open = fsPromises.open;
    let holdFirst = true;
    mock.method(fsPromises, "open", async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === target && holdFirst) {
        holdFirst = false;
        const read = handle.readFile.bind(handle);
        mock.method(handle, "readFile", async (...readArgs) => {
          const content = await read(...readArgs);
          firstEntered();
          await held;
          return content;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
    const firstRun = first.runner.executeApproved(first.approval.id);
    let secondRun;
    let thirdRun;
    let cancel;
    try {
      await entered;
      secondRun = second.runner.executeApproved(second.approval.id);
      void secondRun.catch(() => {});
      // Let the second execution claim its approval and enter FileRunner.
      for (let i = 0; i < 50 && second.runner.getInflightCount() === 0; i++) await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setTimeout(resolve, 25));
      cancel = second.runner.cancelExecution({ taskRunId: second.task.id });
      let deadline;
      const cancellation = await Promise.race([cancel.then(() => "settled"), new Promise(resolve => { deadline = setTimeout(() => resolve("blocked"), 1000); })]);
      clearTimeout(deadline);
      // A cancelled middle waiter must not release the predecessor's ownership.
      thirdRun = new FileRunner().run({ targetDir: f.target, patch: { path: "shared.txt", before: "first\n", after: "third\n" } });
      void thirdRun.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 50));
      releaseFirst();
      const outcomes = await Promise.allSettled([firstRun, secondRun, thirdRun]);
      await cancel;
      assert.deepEqual({ cancellation, second: outcomes[1].status, code: outcomes[1].reason?.code,
        third: outcomes[2].status, content: readFileSync(target, "utf8") },
      { cancellation: "settled", second: "rejected", code: "RUNNER_CANCELLED", third: "fulfilled", content: "third\n" });
      assert.equal((await state.getTaskRun(second.task.id)).status, "cancelled");
    } finally {
      releaseFirst();
      await Promise.allSettled([firstRun, secondRun, thirdRun, cancel].filter(Boolean));
    }
  });
}

test("a pre-aborted file action creates no file", async t => {
  const f = workspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new FileRunner().run({ targetDir: f.target, patch: { path: "cancelled.txt", after: "blocked" }, signal: controller.signal }),
    error => error.code === "RUNNER_CANCELLED");
  await assert.rejects(fsPromises.stat(join(f.target, "cancelled.txt")), error => error.code === "ENOENT");
});
