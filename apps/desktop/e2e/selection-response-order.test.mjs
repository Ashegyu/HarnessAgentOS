import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("a late thread response cannot replace the newly selected thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-selection-"));
  const env = { ...process.env, HARNESS_E2E_USER_DATA: join(root, "data"), HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${join(root, "data")}`], env });
  try {
    const page = await app.firstWindow();
    const fixtures = await page.evaluate(async root => {
      const results = [];
      for (const name of ["Selection A", "Selection B"]) {
        const thread = await window.harness.state.createThread({ title: name, targetDir: root });
        await window.harness.conversation.createTask({ threadId: thread.id, targetDir: root, userRequest: `${name} request`, mode: "template" });
        results.push(await window.harness.state.getThread({ threadId: thread.id }));
      }
      return results;
    }, root);
    await app.evaluate(({ ipcMain }, fixtures) => {
      globalThis.selectionRequests = [];
      ipcMain.removeHandler("state:getThread");
      ipcMain.handle("state:getThread", (_event, input) => new Promise(resolve => {
        globalThis.selectionRequests.push({ id: input.threadId, resolve: () => resolve({ ok: true, value: fixtures.find(f => f.thread.id === input.threadId) }) });
      }));
    }, fixtures);
    await page.reload();
    await page.getByRole("button", { name: /Selection A/ }).click();
    await expect.poll(() => app.evaluate(() => globalThis.selectionRequests.length)).toBe(1);
    await page.getByRole("button", { name: /Selection B/ }).click();
    await expect.poll(() => app.evaluate(() => globalThis.selectionRequests.length)).toBe(2);
    await app.evaluate(() => globalThis.selectionRequests[1].resolve());
    await expect(page.locator(".conversation-workbench")).toContainText("Selection B request");
    await app.evaluate(() => globalThis.selectionRequests[0].resolve());
    // Wait for IPC completion and React's next frame, not a timing-dependent sleep.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator(".conversation-workbench")).toContainText("Selection B request");
    await expect(page.locator(".conversation-workbench")).not.toContainText("Selection A request");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("late task detail cannot expose actions for the previous selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-task-selection-"));
  const userData = join(root, "data");
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${userData}`], env });
  try {
    const page = await app.firstWindow();
    const fixtures = await page.evaluate(async root => {
      const thread = await window.harness.state.createThread({ title: "Task selection", targetDir: root });
      const details = [];
      for (const userRequest of ["Task A request", "Task B request"]) {
        const draft = await window.harness.conversation.createTask({ threadId: thread.id, userRequest, mode: "template" });
        details.push(await window.harness.conversation.getTaskRunDetail({ taskRunId: draft.taskRun.id }));
      }
      return details;
    }, root);
    fixtures[0].taskRun.status = "paused";
    await app.evaluate(({ ipcMain }, fixtures) => {
      globalThis.taskSelectionRequests = []; globalThis.pausedSelectionIds = [];
      ipcMain.removeHandler("conversation:getTaskRunDetail");
      ipcMain.handle("conversation:getTaskRunDetail", (_event, input) => new Promise(resolve => {
        globalThis.taskSelectionRequests.push({ id: input.taskRunId, resolve: () => resolve({ ok: true, value: fixtures.find(f => f.taskRun.id === input.taskRunId) }) });
      }));
      ipcMain.removeHandler("conversation:pauseTask");
      ipcMain.handle("conversation:pauseTask", (_event, input) => {
        globalThis.pausedSelectionIds.push(input.taskRunId);
        return { ok: true, value: { ...fixtures[1].taskRun, status: "paused" } };
      });
    }, fixtures);
    await page.reload();
    await page.getByRole("button", { name: /Task selection/ }).click();
    await page.locator(".chat-turn").filter({ hasText: "Task A request" }).click();
    await expect.poll(() => app.evaluate(() => globalThis.taskSelectionRequests.length)).toBe(1);
    await page.locator(".chat-turn").filter({ hasText: "Task B request" }).click();
    await expect.poll(() => app.evaluate(() => globalThis.taskSelectionRequests.length)).toBe(2);
    await app.evaluate(() => globalThis.taskSelectionRequests[1].resolve());
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await app.evaluate(() => globalThis.taskSelectionRequests[0].resolve());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.pausedSelectionIds)).toEqual([fixtures[1].taskRun.id]);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
