import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

for (const intent of ["answer", "review"]) {
  test(`${intent} completion uses response evidence without running build QA or another model`, async () => {
    const userData = mkdtempSync(join(tmpdir(), "harness-completion-e2e-"));
    const projectDir = mkdtempSync(join(tmpdir(), "harness-completion-project-"));
    const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    let app;
    try {
      const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
      app = await electron.launch({
        args: ["--no-sandbox", ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]), `--user-data-dir=${userData}`],
        env, ...(executablePath ? { executablePath } : {}),
      });
      const page = await app.firstWindow();
      await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
      const taskRunId = await page.evaluate(async ({ targetDir, intent }) => {
        const api = window.harness;
        const thread = await api.state.createThread({ title: "응답 완료 검증", targetDir });
        const draft = await api.conversation.createTask({
          threadId: thread.id, targetDir, mode: "agent", intent,
          userRequest: intent === "answer" ? "이 구조를 설명해줘" : "이 구조를 검토해줘",
        });
        return draft.taskRun.id;
      }, { targetDir: projectDir, intent });
      // Select the task before execution to check push-driven gate updates.
      await page.reload();
      await page.getByRole("button", { name: /응답 완료 검증/ }).click();
      await page.locator(".chat-turn").click();
      await page.getByRole("tab", { name: "QA", exact: true }).click();
      const panel = page.locator("#right-panel-panel-quality");
      await expect(panel).toContainText("응답 검증");
      await page.evaluate(id => window.harness.agent.generatePlan({ taskRunId: id }), taskRunId);
      await expect.poll(async () => {
        const detail = await page.evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), taskRunId);
        return { status: detail.taskRun.status, gate: detail.qualityGates[0]?.status };
      }).toEqual(intent === "answer"
        ? { status: "done", gate: "passed" }
        : { status: "ready_for_review", gate: "warning" });
      const detail = await page.evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), taskRunId);
      expect(detail.agentInvocations).toHaveLength(1);
      expect(detail.agentInvocations[0].status).toBe("succeeded");
      expect(detail.steps.filter(step => ["shell", "test", "edit"].includes(step.kind))).toEqual([]);
      expect(detail.qualityGates[0].buildPassed).toBeUndefined();
      expect(detail.qualityGates[0].testsPassed).toBeUndefined();
      expect(detail.qualityGates[0].evidenceArtifactIds).toContain(detail.agentInvocations[0].parsedPlanArtifactId);
      expect(readdirSync(projectDir)).toEqual([]);
      await expect(panel.getByRole("checkbox")).toHaveCount(0);
      await expect(panel.locator(".quality-panel__metrics")).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Create repair plan", exact: true })).toBeDisabled();
      if (intent === "review") {
        await expect(panel).toContainText("인용 자료와 내용의 타당성은 사용자 확인이 필요합니다");
      } else {
        await expect(panel.locator(".status-pill--passed")).toBeVisible();
      }
      await page.getByRole("button", { name: "Switch to English", exact: true }).click();
      await expect(panel).toContainText("Response validation");
      await page.reload();
      const persisted = await page.evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), taskRunId);
      expect(persisted.taskRun.status).toBe(detail.taskRun.status);
      expect(persisted.agentInvocations).toHaveLength(1);
    } finally {
      if (app) await app.close();
      rmSync(userData, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
}
