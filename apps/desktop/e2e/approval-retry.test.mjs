import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("failed file action is reviewed, persisted as fresh manual consent and executed once", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "harness-retry-ui-"));
  const targetDir = join(root, "project"); mkdirSync(targetDir); writeFileSync(join(targetDir, "retry.txt"), "old");
  const userData = join(root, "data");
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${userData}`], env });
  try {
    const page = await app.firstWindow();
    const task = await page.evaluate(async targetDir => {
      const thread = await window.harness.state.createThread({ title: "Retry UI", targetDir });
      const draft = await window.harness.conversation.createTask({ threadId: thread.id, userRequest: "파일을 수정해줘", mode: "template" });
      const source = draft.approvals[0];
      const configured = await window.harness.conversation.setProposedAction({ approvalId: source.id,
        details: { type: "file_write", filePatch: { path: "retry.txt", before: "wrong baseline", after: "fixed" } } });
      await window.harness.conversation.approve({ approvalId: source.id, expectedRevision: configured.actionRevision });
      return { id: draft.taskRun.id, sourceId: source.id };
    }, targetDir);
    const getDetail = () => page.evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), task.id);
    await expect.poll(async () => (await getDetail()).taskRun.status).toBe("blocked");
    await page.reload();
    await page.getByRole("button", { name: /Retry UI/ }).click();
    await page.locator(".chat-turn").click();
    await page.getByRole("button", { name: "재시도 검토", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "이전 실행 결과 검토" });
    const prepare = dialog.getByRole("button", { name: "새 승인 생성" });
    await expect(prepare).toBeDisabled();
    await dialog.getByLabel("실행 결과 검토 내용").fill("실패한 baseline 검사를 확인했고 실제 파일은 old입니다.");
    await dialog.getByRole("checkbox").check();
    await page.screenshot({ path: testInfo.outputPath("retry-result-review.png") });
    await prepare.click();
    await expect(dialog).toHaveCount(0);
    const reviewed = await getDetail();
    const old = reviewed.approvals.find(a => a.id === task.sourceId);
    const retry = reviewed.approvals.find(a => a.id === old.retryApprovalId);
    expect(old.executionState).toBe("uncertain");
    expect(retry.status).toBe("pending"); expect(retry.requiresManualApproval).toBe(true);
    expect(readFileSync(join(targetDir, "retry.txt"), "utf8")).toBe("old");
    // Refresh configuration through the same IPC used by the existing dialog.
    await page.evaluate(async id => {
      await window.harness.conversation.setProposedAction({ approvalId: id,
        details: { type: "file_write", filePatch: { path: "retry.txt", before: "old", after: "fixed" } } });
    }, retry.id);
    await page.reload();
    await page.getByRole("button", { name: /Retry UI/ }).click();
    await page.locator(".chat-turn").click();
    const card = page.locator(`#approval-card-${retry.id}`);
    await expect(card).toContainText("fixed");
    await expect(card.getByRole("button", { name: "승인 후 실행", exact: true })).toBeDisabled();
    await card.getByLabel("개별 승인 위험 확인").check();
    await card.getByRole("button", { name: "승인 후 실행", exact: true }).click();
    await expect.poll(() => readFileSync(join(targetDir, "retry.txt"), "utf8")).toBe("fixed");
    await expect.poll(async () => (await getDetail()).approvals.find(a => a.id === retry.id)?.executionState).toBe("succeeded");
    const after = await getDetail();
    expect(after.approvals.find(a => a.id === task.sourceId).executionState).toBe("uncertain");
    expect(after.steps.filter(s => s.kind === "edit" && s.status === "succeeded")).toHaveLength(1);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
