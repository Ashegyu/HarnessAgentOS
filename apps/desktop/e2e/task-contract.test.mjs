import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

test("task purpose reaches SQLite through IPC and read-only mode prevents pipeline routing", async () => {
  const userData = mkdtempSync(join(tmpdir(), "harness-contract-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "harness-contract-project-"));
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${userData}`],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "새 작업", exact: true }).click();
    await page.getByLabel("제목").fill("Contract test");
    await page.getByLabel("대상 폴더 (선택)").fill(projectDir);
    await page.getByRole("button", { name: "생성", exact: true }).click();
    await page.getByLabel("작업 목적", { exact: true }).selectOption("review");
    await page.locator(".conversation-input__text").fill("기능을 추가해줘");
    await expect(page.getByRole("status")).toContainText("읽기 전용");
    await expect(page.locator(".conversation-input__pipeline-select").nth(0)).toBeDisabled();
    await expect(page.locator(".conversation-input__pipeline-select").nth(1)).toBeDisabled();
    await page.getByRole("button", { name: "전송", exact: true }).click();
    await expect(page.locator(".chat-turn")).toHaveCount(1);
    const detail = await page.evaluate(async () => {
      const threads = await window.harness.state.listThreads();
      const thread = threads.find((row) => row.title === "Contract test");
      const data = await window.harness.state.getThread({ threadId: thread.id });
      return window.harness.conversation.getTaskRunDetail({ taskRunId: data.taskRuns[0].id });
    });
    expect(detail.taskRun.contract.intent).toBe("review");
    expect(detail.taskRun.contract.origin).toBe("user_mode");
    expect(detail.taskRun.contract.authorization.mode).toBe("read_only");
    expect(detail.approvals).toEqual([]);
    expect(readdirSync(projectDir)).toEqual([]);
    await expect(page.locator(".chat-bubble--user .chat-bubble__meta")).toContainText("읽기 전용");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
