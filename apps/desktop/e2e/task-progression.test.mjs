import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

for (const autoApprove of [false, true]) {
  test(`one HTML request survives renderer reload and completes actual delivery (auto=${autoApprove})`, async ({}, testInfo) => {
    const root = mkdtempSync(join(tmpdir(), "harness-progression-e2e-"));
    const targetDir = join(root, "project");
    mkdirSync(targetDir);
    const userData = join(root, "userData");
    const env = { ...process.env, HARNESS_E2E_USER_DATA: userData,
      HARNESS_E2E_FAKE_AGENT: "1", HARNESS_E2E_SCENARIO: "ok-html-report" };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    try {
      const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
      app = await electron.launch({ args: ["--no-sandbox",
        ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]),
        `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
      const page = await app.firstWindow();
      // An empty workbench with its drawer closed is a valid ready screen.
      // Open it through the real navigation control before using drawer UI.
      await expect(page.getByRole("navigation", { name: "앱 탐색" })).toBeVisible();
      const openThreads = page.getByRole("button", { name: "스레드 패널 열기", exact: true });
      if (await openThreads.isVisible()) await openThreads.click();
      await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
      const threadId = await page.evaluate(async ({ targetDir, autoApprove }) => {
        const settings = await window.harness.settings.get();
        const profiles = await window.harness.agents.list();
        const profile = profiles.find(p => p.id === settings.activeAgentProfileId) ?? profiles.find(p => p.isDefault);
        if (profile) await window.harness.agents.update({ profile: { ...profile,
          permissions: { ...profile.permissions, autoApproveActions: [], blockedActions: [] } } });
        await window.harness.settings.update({ ...settings, approval: { ...settings.approval, autoApprove } });
        return (await window.harness.state.createThread({ title: "HTML 전달 검수", targetDir })).id;
      }, { targetDir, autoApprove });
      await page.reload();
      await page.getByRole("button", { name: /HTML 전달 검수/ }).click();
      const composer = page.locator(".conversation-input");
      await composer.getByRole("textbox").fill("현재 프로젝트를 상세히 분석해서 HTML 파일로 저장해줘");
      await composer.getByRole("button", { name: "전송", exact: true }).click();
      await expect(composer.getByRole("textbox")).toHaveValue("");
      const tasks = (await page.evaluate(id => window.harness.state.getThread({ threadId: id }), threadId)).taskRuns;
      expect(tasks).toHaveLength(1);
      const id = tasks[0].id;
      // Drop all renderer state while main owns the invocation and decisions.
      await page.reload();
      const detail = () => page.evaluate(taskRunId => window.harness.conversation.getTaskRunDetail({ taskRunId }), id);
      if (!autoApprove) {
        // Optional skill/model suggestions are explicit user decisions, never another execute click.
        await expect.poll(async () => (await detail()).artifacts.some(a => a.uri === `harness:planning-ready/${id}`)).toBe(true);
        for (const a of (await detail()).approvals.filter(a => a.status === "pending" && ["model_use", "capability_use"].includes(a.actionType))) {
          await page.evaluate(approvalId => window.harness.conversation.rejectApproval({ approvalId, message: "기본 설정으로 진행" }), a.id);
        }
        await expect.poll(async () => {
          const d = await detail();
          if (["blocked", "cancelled", "done"].includes(d.taskRun.status)) throw new Error(JSON.stringify({ status: d.taskRun.status, approvals: d.approvals, steps: d.steps }));
          return d.approvals.some(a => a.actionType === "file_write" && a.status === "pending");
        }, { timeout: 15000 }).toBe(true);
        expect(existsSync(join(targetDir, "report.html"))).toBe(false);
        await page.getByRole("button", { name: /HTML 전달 검수/ }).click();
        await page.locator(".chat-turn").click();
        await page.locator("#right-panel-tab-plan").click();
        const a = (await detail()).approvals.find(a => a.actionType === "file_write");
        const card = page.locator(`#approval-card-${a.id}`);
        await card.getByRole("button", { name: "승인 후 실행", exact: true }).click();
        await page.reload();
      }
      await expect.poll(async () => {
        const d = await detail();
        return { status: d.taskRun.status, gate: d.qualityGates[0]?.status };
      }, { timeout: 15000 }).toEqual({ status: "done", gate: "passed" });
      const d = await detail();
      expect(d.taskRun.contract.intent).toBe("change");
      expect(d.agentInvocations).toHaveLength(1);
      expect(d.steps.filter(s => s.kind === "edit" && s.status === "succeeded")).toHaveLength(1);
      expect(d.approvals.find(a => a.actionType === "file_write").executionState).toBe("succeeded");
      expect(readFileSync(join(targetDir, "report.html"), "utf8")).toContain("<h1>프로젝트 분석</h1>");
      expect(d.qualityGates[0].testsPassed).toBeUndefined();
      await page.getByRole("button", { name: /HTML 전달 검수/ }).click();
      await expect(page.locator(".chat-turn")).toContainText("완료");
      await page.screenshot({ path: testInfo.outputPath(`html-delivery-${autoApprove}.png`) });
    } finally {
      if (app) await app.close();
      if (resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/")) rmSync(root, { recursive: true, force: true });
    }
  });
}
