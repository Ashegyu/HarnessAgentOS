import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const main = join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js");

test("same userData rejects a second process before claim recovery; isolated userData remains independent", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-instance-e2e-"));
  const target = join(root, "project");
  const userData = join(root, "primary");
  mkdirSync(target);
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1", HARNESS_STARTUP_TRACE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
  const appArgs = path => ["--no-sandbox", ...(executablePath ? [] : [main]), `--user-data-dir=${path}`];
  let primary;
  let independent;
  let duplicate;
  try {
    primary = await electron.launch({ args: appArgs(userData), env, ...(executablePath ? { executablePath } : {}) });
    const page = await primary.firstWindow();
    await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
    expect(await primary.evaluate(({ app }) => app.hasSingleInstanceLock())).toBe(true);
    const draft = await page.evaluate(async targetDir => {
      const thread = await window.harness.state.createThread({ title: "single instance claim", targetDir });
      return window.harness.conversation.createTask({ threadId: thread.id, targetDir,
        userRequest: "검수 파일 수정", intent: "change", mode: "template" });
    }, target);
    const approvalId = draft.approvals[0].id;
    await primary.evaluate(({ app }, id) => {
      globalThis.__instanceProbe = 0;
      app.on("second-instance", () => { globalThis.__instanceProbe += 1; });
      const path = process.getBuiltinModule("node:path");
      const load = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
      const db = new (load("better-sqlite3"))(path.join(app.getPath("userData"), "app.db"));
      try {
        db.prepare("UPDATE approvals SET status='approved', approved_revision=action_revision, execution_state='running', execution_token='instance-probe', execution_started_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
      } finally { db.close(); }
    }, approvalId);

    let output = "";
    duplicate = spawn(executablePath ?? primary.process().spawnfile, appArgs(userData), { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const capture = chunk => { output = (output + chunk.toString()).slice(-32768); };
    duplicate.stdout.on("data", capture);
    duplicate.stderr.on("data", capture);
    const exit = await new Promise((fulfill, reject) => {
      const timer = setTimeout(() => reject(new Error("duplicate app did not exit before startup")), 10000);
      duplicate.once("error", error => { clearTimeout(timer); reject(error); });
      duplicate.once("exit", (code, signal) => { clearTimeout(timer); fulfill({ code, signal }); });
    });
    expect(exit).toEqual({ code: 0, signal: null });
    expect(output).not.toContain("initServices:start");
    // Focus/restore event handling is covered by the deterministic Electron
    // test; this process test verifies exclusion and SQLite claim ownership.
    const claim = await page.evaluate(async ({ taskRunId, approvalId }) => {
      const detail = await window.harness.conversation.getTaskRunDetail({ taskRunId });
      return detail.approvals.find(row => row.id === approvalId).executionState;
    }, { taskRunId: draft.taskRun.id, approvalId });
    expect(claim).toBe("running");
    const finished = await primary.evaluate(({ app }, id) => {
      const path = process.getBuiltinModule("node:path");
      const load = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
      const db = new (load("better-sqlite3"))(path.join(app.getPath("userData"), "app.db"));
      try {
        return db.prepare("UPDATE approvals SET execution_state='succeeded', execution_finished_at=? WHERE id=? AND execution_token='instance-probe' AND execution_state='running'")
          .run(new Date().toISOString(), id).changes;
      } finally { db.close(); }
    }, approvalId);
    expect(finished).toBe(1);

    const isolated = join(root, "independent");
    independent = await electron.launch({ args: appArgs(isolated), env: { ...env, HARNESS_E2E_USER_DATA: isolated },
      ...(executablePath ? { executablePath } : {}) });
    await expect((await independent.firstWindow()).getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
    expect(await independent.evaluate(({ app }) => app.getPath("userData"))).toBe(isolated);
    expect(await primary.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
  } finally {
    if (duplicate && duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill();
    if (independent) await independent.close();
    if (primary) await primary.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep)) rmSync(root, { recursive: true, force: true });
  }
});
