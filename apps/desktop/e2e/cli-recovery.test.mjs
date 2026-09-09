import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("missing CLI preserves input and creates no empty task; reconnect submits an agent task", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-recovery-"));
  const userData = join(root, "userData");
  const targetDir = join(root, "project");
  mkdirSync(targetDir);
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${userData}`], env });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
    const threadId = await page.evaluate(async targetDir => {
      const thread = await window.harness.state.createThread({ title: "CLI 복구 검수", targetDir });
      return thread.id;
    }, targetDir);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("agent:checkProviders");
      ipcMain.handle("agent:checkProviders", () => ({ ok: true, value: { codex: { available: false, error: "spawn codex ENOENT", queueDepth: 0 } } }));
    });
    await page.reload();
    await page.getByRole("button", { name: /CLI 복구 검수/ }).click();
    const composer = page.locator(".conversation-input");
    const input = composer.getByRole("textbox");
    const request = "현재 프로젝트를 상세히 분석해서 HTML 파일로 저장해줘";
    await input.fill(request);
    await composer.getByRole("button", { name: "전송", exact: true }).click();
    await expect(composer.getByRole("alert")).toContainText("CLI 연결");
    await expect(input).toHaveValue(request);
    expect((await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId)).taskRuns).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("cli-unavailable.png") });

    // A failed IPC probe is also a connection failure, never template fallback.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("agent:checkProviders");
      ipcMain.handle("agent:checkProviders", () => { throw new Error("fixture probe failed"); });
    });
    await composer.getByRole("button", { name: "CLI 다시 확인", exact: true }).click();
    await expect(composer.getByRole("alert")).toContainText("CLI 연결 확인에 실패");
    await expect(input).toHaveValue(request);
    expect((await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId)).taskRuns).toHaveLength(0);

    await page.getByRole("button", { name: "Switch to English", exact: true }).click();
    await expect(composer.getByRole("button", { name: "Recheck CLI", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "한국어로 전환", exact: true }).click();

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("agent:checkProviders");
      ipcMain.handle("agent:checkProviders", () => ({ ok: true, value: { codex: { available: true, version: "e2e-fake", command: "in-process", queueDepth: 0 } } }));
    });
    await composer.getByRole("button", { name: "CLI 다시 확인", exact: true }).click();
    await expect(composer.getByRole("alert")).toHaveCount(0);
    await expect(input).toHaveValue(request);
    await composer.getByRole("button", { name: "전송", exact: true }).click();
    await expect(input).toHaveValue("");
    const detail = await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId);
    expect(detail.taskRuns).toHaveLength(1);
    const task = await page.evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), detail.taskRuns[0].id);
    expect(task.approvals.filter(row => row.actionType === "file_write" && !row.proposedAction)).toHaveLength(0);
    expect(task.artifacts.some(row => row.summary?.includes("Phase 2는 deterministic template"))).toBe(false);
  } finally {
    if (app) await app.close();
    // The generated fixture root is the only recursive cleanup target.
    if (resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/")) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
