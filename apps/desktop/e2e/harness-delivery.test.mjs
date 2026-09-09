import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

for (const variant of ["html", "code", "budget", "failed", "conflict"]) {
test(`selected harness ${variant}: progression, delivery and truthful state`, async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "harness-full-delivery-"));
  const targetDir = join(root, "project");
  mkdirSync(targetDir);
  if (variant === "code") {
    writeFileSync(join(targetDir, "util.cjs"), "exports.add = (a, b) => a - b;\n");
    writeFileSync(join(targetDir, "util.test.cjs"), "require('node:test')('regression passed', () => require('node:assert/strict').equal(require('./util.cjs').add(2, 3), 5));\n");
  }
  const userData = join(root, "userData");
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData,
    HARNESS_E2E_FAKE_AGENT: "1", HARNESS_E2E_SCENARIO: variant === "code" ? "code-harness" : variant === "failed" ? "failed-harness" : "html-harness" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  let lastDetail;
  try {
    const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
    app = await electron.launch({ args: ["--no-sandbox",
      ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]),
      `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
    const threadId = await page.evaluate(async ({ targetDir, variant }) => {
      const api = window.harness;
      const settings = await api.settings.get();
      // This case verifies the execution path, not unverifiable CLI dollar caps.
      // Remove limits only in this isolated fake-model fixture (no live DB/calls).
      for (const profile of variant === "budget" ? [] : await api.agents.list()) {
        const { budget, ...permissions } = profile.permissions;
        await api.agents.update({ profile: { ...profile, permissions } });
      }
      await api.settings.update({ ...settings, orchestration: { ...settings.orchestration, enabled: true } });
      return (await api.state.createThread({ title: "실제 HTML 하네스 검수", targetDir })).id;
    }, { targetDir, variant });
    await page.reload();
    await page.getByRole("button", { name: /실제 HTML 하네스 검수/ }).click();
    const composer = page.locator(".conversation-input");
    const request = variant === "code" ? "util.cjs의 덧셈 버그를 수정해줘" : "프로젝트를 분석해서 report.html 파일로 저장해줘";
    await composer.getByRole("textbox").fill(request);
    const harnessName = variant === "code" ? "버그 수정·회귀 검증 하네스" : "HTML 분석 보고서 하네스";
    const harness = composer.locator("select").filter({ has: page.locator("option", { hasText: harnessName }) });
    await harness.selectOption(await harness.locator("option").filter({ hasText: harnessName }).getAttribute("value"));
    if (variant === "conflict") {
      await composer.getByLabel("작업 목적", { exact: true }).selectOption("review");
      await composer.getByRole("button", { name: "전송", exact: true }).click();
      await expect(composer.getByRole("alert")).toContainText("읽기 전용");
      await expect(composer.getByRole("textbox")).toHaveValue(request);
      expect((await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId)).taskRuns).toHaveLength(0);
      await composer.getByRole("button", { name: "하네스·파이프라인 선택 해제", exact: true }).click();
      await expect(harness).toHaveValue("");
      return;
    }
    await composer.getByRole("button", { name: "전송", exact: true }).click();
    await expect(composer.getByRole("textbox")).toHaveValue("");
    const tasks = (await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId)).taskRuns;
    expect(tasks).toHaveLength(1);
    const id = tasks[0].id;
    await page.reload();
    const detail = () => page.evaluate(taskRunId => window.harness.conversation.getTaskRunDetail({ taskRunId }), id);
    if (variant === "budget" || variant === "failed") {
      await expect.poll(async () => (await detail()).taskRun.status).toBe("blocked");
      const d = await detail();
      lastDetail = d;
      expect(d.agentInvocations).toHaveLength(variant === "budget" ? 0 : 2);
      expect(d.approvals.filter(a => a.actionType === "file_write")).toHaveLength(0);
      expect(d.qualityGates.filter(g => g.status === "passed")).toHaveLength(0);
      expect(existsSync(join(targetDir, "report.html"))).toBe(false);
      expect(JSON.stringify(d.artifacts)).toContain(variant === "budget" ? "USD" : "spawn-failed");
      await app.close(); app = null;
      app = await electron.launch({ args: ["--no-sandbox",
        ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]),
        `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
      const reopened = await app.firstWindow();
      await expect(reopened.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
      const persisted = await reopened.evaluate(taskRunId => window.harness.conversation.getTaskRunDetail({ taskRunId }), id);
      expect(persisted.taskRun.status).toBe("blocked");
      expect(persisted.agentInvocations).toHaveLength(d.agentInvocations.length);
      return;
    }
    if (variant === "code") {
      await expect.poll(async () => (await detail()).approvals.some(a => a.actionType === "shell" && a.status === "pending")).toBe(true);
      expect(readFileSync(join(targetDir, "util.cjs"), "utf8")).toContain("a + b");
      expect((await detail()).agentInvocations).toHaveLength(2);
      await page.getByRole("button", { name: /실제 HTML 하네스 검수/ }).click();
      await page.locator(".chat-turn").click();
      await page.locator("#right-panel-tab-plan").click();
      const approval = (await detail()).approvals.find(a => a.actionType === "shell");
      await page.locator(`#approval-card-${approval.id}`).getByRole("checkbox", { name: "개별 승인 위험 확인" }).check();
      await page.locator(`#approval-card-${approval.id}`).getByRole("button", { name: "승인 후 실행", exact: true }).click();
      await page.reload();
    }
    await expect.poll(async () => {
      const d = await detail();
      lastDetail = d;
      if (["blocked", "quality_failed"].includes(d.taskRun.status)) {
        await testInfo.attach("failure-detail", { body: JSON.stringify(d, null, 2), contentType: "application/json" });
        throw new Error(JSON.stringify({ status: d.taskRun.status, steps: d.steps,
          outputs: d.artifacts.filter(a => a.title.startsWith("Worker output")).map(a => a.summary),
          gates: d.qualityGates, approvals: d.approvals.map(a => ({ type: a.actionType, status: a.status, execution: a.executionState })) }));
      }
      return d.taskRun.status;
    }, { timeout: 20000 }).toBe("done");
    const d = await detail();
    await testInfo.attach("delivery-evidence", { body: JSON.stringify(d, null, 2), contentType: "application/json" });
    expect(d.agentInvocations).toHaveLength(3);
    expect(d.agentInvocations.every(i => i.status === "succeeded")).toBe(true);
    expect(d.approvals.filter(a => a.actionType === (variant === "code" ? "file_patch" : "file_write") && a.executionState === "succeeded")).toHaveLength(1);
    if (variant === "code") {
      expect(d.approvals.filter(a => a.actionType === "shell" && a.executionState === "succeeded")).toHaveLength(1);
      expect(JSON.stringify(d.artifacts)).toContain("regression passed");
    } else expect(readFileSync(join(targetDir, "report.html"), "utf8")).toContain("<h1>프로젝트 분석</h1>");
    await page.getByRole("button", { name: /실제 HTML 하네스 검수/ }).click();
    const answer = page.locator(".chat-turn").first();
    await expect(answer).toContainText("완료");
    // Internal response envelopes belong in logs, never in the final answer.
    await expect(answer).not.toContainText("harness_agent_plan");
    if (variant === "html") await expect(answer).toContainText("report.html");
    await page.screenshot({ path: testInfo.outputPath("selected-html-harness.png") });
  } finally {
    if (lastDetail) await testInfo.attach("last-detail", { body: JSON.stringify(lastDetail, null, 2), contentType: "application/json" });
    if (app) await app.close();
    const absoluteRoot = resolve(root);
    if (absoluteRoot.startsWith(resolve(tmpdir()) + "\\") || absoluteRoot.startsWith(resolve(tmpdir()) + "/")) {
      rmSync(absoluteRoot, { recursive: true, force: true });
    }
  }
});
}
