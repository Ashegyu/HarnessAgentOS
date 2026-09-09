import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("saved USD cap blocks parallel planner IPC calls before any model invocation", async () => {
  const userData = mkdtempSync(join(tmpdir(), "harness-budget-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "harness-budget-project-"));
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({
      args: ["--no-sandbox", join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js"), `--user-data-dir=${userData}`],
      env,
    });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "새 작업", exact: true })).toBeVisible();
    const result = await page.evaluate(async (targetDir) => {
      const api = window.harness;
      const seed = (await api.agents.list()).find((profile) => profile.role === "planner");
      const profile = await api.agents.update({ profile: {
        ...seed,
        tuning: { ...seed.tuning, model: "gpt-5.6-luna", reasoningEffort: "low" },
        permissions: { ...seed.permissions, budget: { perInvocationUsd: 0.1 } },
      } });
      await api.agents.setActive({ profileId: profile.id });
      const thread = await api.state.createThread({ title: "예산 차단 검증", targetDir });
      const draft = await api.conversation.createTask({
        threadId: thread.id, targetDir, mode: "agent", userRequest: "구조를 설명해줘",
      });
      const attempts = await Promise.allSettled([1, 2].map(() =>
        api.agent.generatePlan({ taskRunId: draft.taskRun.id }),
      ));
      return {
        attempts: attempts.map((attempt) => attempt.status === "rejected"
          ? { status: attempt.status, message: attempt.reason.message }
          : { status: attempt.status }),
        profile: await api.agents.get({ profileId: profile.id }),
        detail: await api.conversation.getTaskRunDetail({ taskRunId: draft.taskRun.id }),
      };
    }, projectDir);
    expect(result.profile.tuning.model).toBe("gpt-5.6-luna");
    expect(result.profile.permissions.budget.perInvocationUsd).toBe(0.1);
    for (const attempt of result.attempts) {
      expect(attempt.status).toBe("rejected");
      // The preload bridge preserves the error code in the message prefix;
      // custom Error properties are not the cross-context contract.
      expect(attempt.message).toContain("[AGENT_BUDGET_UNVERIFIABLE]");
      expect(attempt.message).toContain("미확인");
    }
    expect(result.detail.agentInvocations).toEqual([]);
    expect(result.detail.approvals).toEqual([]);
    expect(result.detail.taskRun.status).toBe("blocked");
    expect(result.detail.steps.filter(step => step.outputSummary?.includes("AGENT_BUDGET_UNVERIFIABLE"))).toHaveLength(1);
    await page.reload();
    await page.getByRole("button", { name: /예산 차단 검증/ }).click();
    await page.locator(".chat-turn").click();
    await page.getByRole("tab", { name: "에이전트", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("자동으로 재시도하지 않습니다");
    await expect(page.getByRole("alert")).toContainText("설정 → 에이전트");
    await expect(page.getByRole("button", { name: "Agent plan 생성", exact: true })).toBeEnabled();
  } finally {
    if (app) await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
