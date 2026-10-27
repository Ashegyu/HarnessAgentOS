import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test("starter routes expose budget blockers truthfully and the HTML harness remains selectable", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "harness-catalog-e2e-"));
  const userData = join(root, "userData");
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
    app = await electron.launch({ args: ["--no-sandbox",
      ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]),
      `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
    const page = await app.firstWindow();
    await expect(page.getByRole("main", { name: "Conversation workbench" })).toBeVisible();
    const result = await page.evaluate(async targetDir => {
      const api = window.harness;
      const definitions = await api.harnessPackages.list();
      const bindings = await api.harnessPackages.listBindingSets();
      const routes = [];
      for (const binding of bindings) {
        const preview = await api.harnessPackages.previewPipelineDraft({ packageId: binding.packageId,
          workflowId: binding.workflowId, bindings: binding.bindings });
        routes.push({ id: binding.packageId, ok: preview.ok, errors: preview.issues, readiness: preview.readiness });
      }
      const settings = await api.settings.get();
      await api.settings.update({ ...settings, orchestration: { ...settings.orchestration, enabled: true } });
      await api.state.createThread({ title: "새 하네스 선택 검수", targetDir });
      return { definitions: definitions.length, bindings: bindings.length, routes };
    }, root);
    expect(result.definitions).toBe(18);
    expect(result.bindings).toBe(18);
    expect(result.routes.filter(route => !route.ok)).toEqual([]);
    expect(result.routes.some(route => route.readiness?.issues.some(issue => issue.code === "HARNESS_BUDGET_UNVERIFIABLE"))).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "스레드 패널 열기" }).click();
    await page.getByRole("button", { name: /새 하네스 선택 검수/ }).click();
    const harness = page.locator(".conversation-input select").filter({
      has: page.locator("option", { hasText: "HTML 분석 보고서 하네스" }),
    });
    await expect(harness).toBeEnabled();
    const option = await harness.locator("option").filter({ hasText: "HTML 분석 보고서 하네스" }).getAttribute("value");
    await harness.selectOption(option);
    await expect(harness).toHaveValue(option);
    await page.screenshot({ path: testInfo.outputPath("harness-catalog.png") });
  } finally {
    if (app) await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + "\\") || resolve(root).startsWith(resolve(tmpdir()) + "/")) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
