import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { openDb, closeDb, LocalStateService } from "../../../packages/storage/src/index.ts";

const require = createRequire(import.meta.url);
const mainUrl = new URL("./main.ts", import.meta.url);
const mainSource = readFileSync(mainUrl, "utf8");
const mainScript = ts.transpileModule(mainSource.replaceAll("import.meta.url", JSON.stringify(mainUrl.href)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const claimFixture = async () => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "live owner", targetDir: "/tmp/project" });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "Write file", targetDir: "/tmp/project", status: "running" });
  const step = await state.createStep({ taskRunId: task.id, index: 0, kind: "approval", title: "Write", status: "running" });
  const checkpoint = await state.createCheckpoint({ taskRunId: task.id, stepId: step.id, reason: "before_edit", stateRef: "{}", summary: "pending write" });
  const approval = await state.createApproval({ taskRunId: task.id, checkpointId: checkpoint.id,
    actionType: "file_write", actionSummary: "Write file", status: "approved" });
  db.prepare("UPDATE approvals SET execution_state='running' WHERE id=?").run(approval.id);
  const executionState = () => db.prepare("SELECT execution_state FROM approvals WHERE id=?").get(approval.id).execution_state;
  return { db, executionState };
};

// Execute the real main.ts top level with fake Electron and an actual SQLite
// connection. Stop initialization immediately after its recovery SQL so no
// renderer, provider, IPC or external process is started by this test harness.
const runMain = async ({ db, lock = true, windows = [] }) => {
  const calls = [];
  const listeners = new Map();
  const app = {
    requestSingleInstanceLock() { calls.push("lock"); return lock; },
    whenReady() { calls.push("ready"); return Promise.resolve(); },
    getPath(name) { assert.equal(name, "userData"); return "/tmp/single-instance-profile"; },
    quit() { calls.push("quit"); },
    on(event, listener) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(listener);
      listeners.set(event, handlers);
      return app;
    },
  };
  const helperUrl = new URL("./single-instance.ts", import.meta.url);
  const helper = existsSync(helperUrl) ? await import(helperUrl.href) : {};
  const shutdown = await import("./services/application-shutdown.ts");
  const sandbox = {
    exports: {}, process: { env: {}, platform: "win32" },
    console: { log() {}, error() {} },
    require(id) {
      if (id.startsWith("node:")) return require(id);
      if (id === "electron") return { app, BrowserWindow: { getAllWindows: () => windows } };
      if (id === "@harness/storage") return {
        openDb() { calls.push("db"); return db; },
        LocalStateService: class { constructor() { throw new Error("test stops after recovery"); } },
      };
      if (id === "./single-instance") return helper;
      if (id === "./services/application-shutdown") return shutdown;
      return {};
    },
  };
  vm.runInNewContext(mainScript, sandbox, { filename: "main.cjs" });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  return { calls, emit(event) { for (const listener of listeners.get(event) ?? []) listener(); }, listeners };
};

test("a second instance quits before DB startup and leaves a live owner's claim running", async () => {
  const f = await claimFixture();
  try {
    const second = await runMain({ db: f.db, lock: false });
    assert.equal(f.executionState(), "running", "the losing process cannot recover another live process's claim");
    assert.deepEqual(second.calls, ["lock", "quit"]);
    assert.equal(second.listeners.size, 0, "the losing process does not register application bootstrap callbacks");
  } finally { closeDb(f.db); }
});

test("the primary instance acquires ownership before recovering an abandoned claim", async () => {
  const f = await claimFixture();
  try {
    const primary = await runMain({ db: f.db });
    assert.deepEqual(primary.calls, ["lock", "ready", "db", "quit"]);
    assert.equal(f.executionState(), "uncertain", "owner startup retains crash recovery without replaying the action");
  } finally { closeDb(f.db); }
});

test("second-instance restores and focuses the live window without repeating startup recovery", async () => {
  const f = await claimFixture();
  const windowCalls = [];
  const window = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => windowCalls.push("restore"), show: () => windowCalls.push("show"), focus: () => windowCalls.push("focus") };
  try {
    const primary = await runMain({ db: f.db, windows: [window] });
    primary.emit("second-instance");
    assert.deepEqual(windowCalls, ["restore", "show", "focus"]);
    assert.equal(primary.calls.filter(call => call === "db").length, 1);
  } finally { closeDb(f.db); }
});

test("second-instance before a window exists does not open another DB or create a window", async () => {
  const f = await claimFixture();
  try {
    const primary = await runMain({ db: f.db });
    assert.doesNotThrow(() => primary.emit("second-instance"));
    assert.equal(primary.calls.filter(call => call === "db").length, 1);
    assert.ok(primary.listeners.has("second-instance"));
  } finally { closeDb(f.db); }
});
