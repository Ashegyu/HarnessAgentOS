import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, "..");
const MAIN_ENTRY = join(APP_ROOT, "out/main/main.js");

const launchIsolatedApp = async () => {
  const userData = mkdtempSync(join(tmpdir(), "harness-e2e-"));
  const projectDir = mkdtempSync(join(tmpdir(), "harness-e2e-project-"));
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      // Force a fresh, sandboxed state directory so the test never
      // collides with the developer's real userData.
      HARNESS_E2E_USER_DATA: userData,
    },
  });
  return {
    app,
    projectDir,
    cleanup: async () => {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
};

/**
 * Smoke harness — boots the built Electron bundle against an isolated
 * userData dir so the test never touches the developer's real database.
 *
 * Coverage is intentionally narrow: launch + render + create-thread
 * round-trip. Deeper flows (approval/runner/quality) belong in unit
 * tests where they aren't gated on the OS dialog/native modules.
 */
test("workbench launches and creates a thread", async () => {
  const { app, projectDir, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Sidebar header is in Korean per UX, so anchor on the aria-label
    // we control instead.
    const sidebar = window.locator('aside[aria-label="Thread sidebar"]');
    await expect(sidebar).toBeVisible();

    await window.getByRole("button", { name: "새 작업" }).click();
    await window.getByLabel("제목").fill("E2E smoke thread");
    await window.getByLabel("대상 폴더 (선택)").fill(projectDir);
    await window.getByRole("button", { name: "생성" }).click();

    await expect(
      window.getByRole("button", { name: /E2E smoke thread/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("region", { name: "새 대화 시작" }),
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("settings pipelines tab exposes seeded templates and request ranking", async () => {
  const { app, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "설정 열기" }).click();
    await expect(window.getByRole("dialog", { name: "설정" })).toBeVisible();

    await window.getByRole("tab", { name: "Pipelines" }).click();
    const pipelineList = window.locator(".pipelines-tab__items");
    await expect(pipelineList).toBeVisible();
    await expect(
      window.getByRole("button", { name: /Build Recovery/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: /Refactor Safety/ }),
    ).toBeVisible();

    await window.getByLabel("파이프라인 요청 유형").fill("빌드 에러");
    await expect(pipelineList.locator("li").first()).toContainText(
      "Build Recovery",
    );
    await expect(pipelineList.locator("li").first()).toContainText(
      "빌드/타입/lint/test 실패 복구",
    );

    await window.getByLabel("파이프라인 요청 유형").fill("리팩터링");
    await expect(pipelineList.locator("li").first()).toContainText(
      "Refactor Safety",
    );
  } finally {
    await cleanup();
  }
});
