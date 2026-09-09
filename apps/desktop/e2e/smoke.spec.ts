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
    args: ["--no-sandbox", MAIN_ENTRY, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      // Force a fresh, sandboxed state directory so the test never
      // collides with the developer's real userData.
      HARNESS_E2E_USER_DATA: userData,
      // Exercise the complete Electron IPC/orchestration/UI path without
      // invoking a developer's real Codex CLI or consuming remote capacity.
      HARNESS_E2E_FAKE_AGENT: "1",
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

    const sidebar = window.locator('aside[aria-label="스레드 사이드바"]');
    await expect(sidebar).toBeVisible();

    await window
      .getByRole("button", { name: "새 작업", exact: true })
      .click();
    await window.getByLabel("제목").fill("E2E smoke thread");
    await window.getByLabel("대상 폴더 (선택)").fill(projectDir);
    await window.getByRole("button", { name: "생성" }).click();

    await expect(
      window.getByRole("button", { name: /E2E smoke thread/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("region", { name: "새 대화 시작" }),
    ).toBeVisible();

    const thread = await window.evaluate(async () => {
      const threads = await window.harness.state.listThreads();
      return threads.find((item) => item.title === "E2E smoke thread") ?? null;
    });
    expect(thread).not.toBeNull();
    const firstTaskRun = await window.evaluate(
      async ({ threadId, targetDir }) => {
        const draft = await window.harness.conversation.createTask({
          threadId,
          targetDir,
          mode: "template",
          userRequest: "첫 번째 태스크를 생성해줘",
        });
        return draft.taskRun;
      },
      { threadId: thread!.id, targetDir: projectDir },
    );
    await expect(window.locator(".chat-turn")).toHaveCount(1);

    await window.evaluate(
      async ({ threadId, targetDir, followUpTaskRunId }) => {
        await window.harness.conversation.createTask({
          threadId,
          targetDir,
          mode: "template",
          followUpTaskRunId,
          userRequest: "앞선 태스크를 이어서 점검해줘",
        });
      },
      {
        threadId: thread!.id,
        targetDir: projectDir,
        followUpTaskRunId: firstTaskRun.id,
      },
    );
    await expect(window.locator(".chat-turn")).toHaveCount(2);
    const threadDetail = await window.evaluate(async ({ threadId }) => {
      return window.harness.state.getThread({ threadId });
    }, { threadId: thread!.id });
    const followUpTaskRun = threadDetail.taskRuns.find(
      (item) => item.userRequest === "앞선 태스크를 이어서 점검해줘",
    );
    expect(followUpTaskRun?.followUpTaskRunId).toBe(firstTaskRun.id);
    await expect(window.locator(".conversation-input__followup")).toBeVisible();
    await expect(window.locator(".thread-task-flow")).toBeVisible();
    await expect(window.locator(".thread-task-flow__node")).toHaveCount(2);
    await expect(window.locator(".thread-task-flow__connector")).toHaveCount(1);
    await expect(window.locator(".chat-turn__thread-link").first()).toContainText(
      "다음 태스크",
    );

    // 실제 Electron 창의 CSS Grid 경계를 측정해 drawer 리사이저와 본문
    // offset이 다시 어긋나거나 최소 창에서 가로 스크롤이 생기는 회귀를 막는다.
    await window.locator(".chat-turn").last().click();
    await expect(window.locator(".context-drawer")).toHaveClass(/context-drawer--open/);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
    });
    await expect.poll(() => window.evaluate(() => window.innerWidth)).toBe(1280);
    await expect
      .poll(() =>
        window.evaluate(() =>
          document
            .querySelector(".context-drawer")!
            .getBoundingClientRect().width,
        ),
      )
      .toBe(380);

    const wideLayout = await window.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        if (!bounds) throw new Error(`Missing layout element: ${selector}`);
        return {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return {
        rail: rect(".slim-rail"),
        thread: rect(".thread-drawer"),
        main: rect(".conversation-workbench"),
        context: rect(".context-drawer"),
        status: rect(".runtime-status-bar"),
        threadResizer: rect(".workbench-resizer--thread"),
        contextResizer: rect(".workbench-resizer--context"),
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(wideLayout.rail.width).toBe(60);
    expect(wideLayout.thread.width).toBe(272);
    expect(wideLayout.main.width).toBe(568);
    expect(wideLayout.context.width).toBe(380);
    expect(wideLayout.status.height).toBe(32);
    expect(wideLayout.thread.right).toBe(wideLayout.main.left);
    expect(wideLayout.main.right).toBe(wideLayout.context.left);
    expect(
      wideLayout.threadResizer.left + wideLayout.threadResizer.width / 2,
    ).toBe(wideLayout.thread.right);
    expect(
      wideLayout.contextResizer.left + wideLayout.contextResizer.width / 2,
    ).toBe(wideLayout.context.left);
    expect(wideLayout.scrollWidth).toBe(wideLayout.viewportWidth);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(960, 600);
    });
    await expect.poll(() => window.evaluate(() => window.innerWidth)).toBe(960);
    await expect
      .poll(() =>
        window.evaluate(() =>
          Math.round(
            document
              .querySelector(".conversation-workbench")!
              .getBoundingClientRect().width,
          ),
        ),
      )
      .toBe(400);
    const compactLayout = await window.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        if (!bounds) throw new Error(`Missing layout element: ${selector}`);
        return {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
        };
      };
      return {
        thread: rect(".thread-drawer"),
        main: rect(".conversation-workbench"),
        context: rect(".context-drawer"),
        resizerDisplay: getComputedStyle(
          document.querySelector(".workbench-resizer--thread")!,
        ).display,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(compactLayout.thread.width).toBe(200);
    expect(compactLayout.main.width).toBe(400);
    expect(compactLayout.context.width).toBe(300);
    expect(compactLayout.thread.right).toBe(compactLayout.main.left);
    expect(compactLayout.main.right).toBe(compactLayout.context.left);
    expect(compactLayout.resizerDisplay).toBe("none");
    expect(compactLayout.scrollWidth).toBe(compactLayout.viewportWidth);
  } finally {
    await cleanup();
  }
});

test("language toggle persists Korean and English UI preference", async () => {
  const { app, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await expect(window.locator(".panel-header__title").first()).toContainText("스레드");
    await window.getByRole("button", { name: "Switch to English" }).click();
    await expect(window.locator(".panel-header__title").first()).toContainText(/threads/i);
    await expect.poll(() => window.evaluate(async () => (
      await window.harness.settings.get()
    ).ui.language)).toBe("en");
    const untranslatedVisibleText = await window.evaluate(() => {
      const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const values = new Set<string>();
      for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
        const text = node.textContent?.trim() ?? "";
        const parent = node.parentElement;
        if (!text || !/[가-힣]/.test(text) || !parent) continue;
        const style = window.getComputedStyle(parent);
        if (style.display !== "none" && style.visibility !== "hidden") {
          values.add(text);
        }
      }
      return [...values].sort();
    });
    // The language toggle intentionally shows the destination language.
    expect(untranslatedVisibleText).toEqual(["한"]);

    await window.getByRole("button", { name: "Open settings" }).click();
    const settingsDialog = window.getByRole("dialog", { name: "Settings" });
    const parallelLimit = settingsDialog.getByLabel(
      "Maximum parallel AI workers",
    );
    await expect(parallelLimit).toHaveValue("3");
    await parallelLimit.fill("4");
    await settingsDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settingsDialog).toBeHidden();
    await expect.poll(() => window.evaluate(async () => (
      await window.harness.settings.get()
    ).orchestration.maxParallelWorkers)).toBe(4);

    await window.getByRole("button", { name: "한국어로 전환" }).click();
    await expect(window.locator(".panel-header__title").first()).toContainText("스레드");
    await expect.poll(() => window.evaluate(async () => (
      await window.harness.settings.get()
    ).ui.language)).toBe("ko");
  } finally {
    await cleanup();
  }
});

test("parallel pipeline is bounded, visible, and cancellable in Electron", async () => {
  test.setTimeout(60_000);
  const { app, projectDir, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    const setup = await window.evaluate(async ({ targetDir }) => {
      const profiles = await window.harness.agents.list();
      if (profiles.length < 3) throw new Error("Expected seeded agent profiles");

      const settings = await window.harness.settings.get();
      await window.harness.settings.update({
        ...settings,
        orchestration: {
          ...settings.orchestration,
          enabled: true,
          maxParallelWorkers: 2,
        },
      });
      const pipeline = await window.harness.pipeline.create({
        pipeline: {
          name: "E2E bounded parallel",
          description: "Three independent workers with a two-worker limit.",
          steps: profiles.slice(0, 3).map((profile, index) => ({
            id: `parallel_${index + 1}`,
            agentProfileId: profile.id,
            title: `Parallel worker ${index + 1}`,
            instruction: `Return worker result ${index + 1}.`,
            expectedArtifactKinds: ["plan"],
            dependsOn: [],
            allowedActions: [],
            outputContract: "plan",
          })),
        },
      });
      const thread = await window.harness.state.createThread({
        title: "E2E parallel task",
        targetDir,
        pipelineId: pipeline.id,
      });
      const draft = await window.harness.conversation.startTask({
        threadId: thread.id, targetDir,
        userRequest: "세 작업을 동시에 실행해줘",
        orchMode: "multi_worker", orchPipelineId: pipeline.id,
      });
      return {
        threadId: thread.id,
        taskRunId: draft.taskRun.id,
        pipelineId: pipeline.id,
      };
    }, { targetDir: projectDir });

    // The setup uses the typed preload API directly, so reload once to hydrate
    // the sidebar from the canonical SQLite state before selecting the thread.
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.getByRole("button", { name: /E2E parallel task/ }).click();
    await expect(window.locator(".chat-turn")).toHaveCount(1);
    await window.locator(".chat-turn").click();
    await expect(window.locator(".chat-turn--selected")).toHaveCount(1);

    await expect.poll(async () => {
      const detail = await window.evaluate(
        ({ taskRunId }) =>
          window.harness.conversation.getTaskRunDetail({ taskRunId }),
        { taskRunId: setup.taskRunId },
      );
      return {
        status: detail.taskRun.status,
        approvals: detail.approvals.map(a => ({ type: a.actionType, status: a.status, decision: a.decisionMessage })),
        errors: detail.steps.filter(s => s.status === "failed").map(s => s.outputSummary),
        running: detail.agentInvocations.filter(
          (invocation) => invocation.status === "running",
        ).length,
        queued: detail.agentInvocations.filter(
          (invocation) => invocation.status === "queued",
        ).length,
      };
    }).toMatchObject({ running: 2, queued: 0 });
    await expect.poll(async () =>
      window.locator(".parallel-execution-status").textContent(),
    ).toMatch(/병렬 실행 중 2\/3.*대기 중 1/);
    await expect.poll(async () => {
      const detail = await window.evaluate(
        ({ taskRunId }) =>
          window.harness.conversation.getTaskRunDetail({ taskRunId }),
        { taskRunId: setup.taskRunId },
      );
      return detail.agentInvocations.filter(
        (invocation) => invocation.status === "succeeded",
      ).length;
    }, { timeout: 20_000 }).toBe(3);

    const cancelSetup = await window.evaluate(async ({ threadId, targetDir, pipelineId }) => {
      const draft = await window.harness.conversation.startTask({
        threadId, targetDir,
        userRequest: "취소 동작도 확인해줘",
        orchMode: "multi_worker", orchPipelineId: pipelineId,
      });
      return { taskRunId: draft.taskRun.id };
    }, {
      threadId: setup.threadId,
      targetDir: projectDir,
      pipelineId: setup.pipelineId,
    });
    await expect(window.locator(".chat-turn")).toHaveCount(2);
    // Select via the visible task navigator; its sticky header can cover the chat card center.
    await window.locator(".thread-task-flow__node").last().click();
    await expect.poll(async () => {
      const detail = await window.evaluate(
        ({ taskRunId }) =>
          window.harness.conversation.getTaskRunDetail({ taskRunId }),
        { taskRunId: cancelSetup.taskRunId },
      );
      return detail.agentInvocations.filter(
        (invocation) => invocation.status === "running",
      ).length;
    }).toBe(2);
    await window.evaluate(
      ({ taskRunId }) =>
        window.harness.conversation.cancelTask({
          taskRunId,
          reason: "E2E cancellation verification",
        }),
      { taskRunId: cancelSetup.taskRunId },
    );
    await expect.poll(async () => {
      const detail = await window.evaluate(
        ({ taskRunId }) =>
          window.harness.conversation.getTaskRunDetail({ taskRunId }),
        { taskRunId: cancelSetup.taskRunId },
      );
      return {
        status: detail.taskRun.status,
        invocationCount: detail.agentInvocations.length,
        allCancelled: detail.agentInvocations.every(
          (invocation) => invocation.status === "cancelled",
        ),
      };
    }).toEqual({ status: "cancelled", invocationCount: 2, allCancelled: true });
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

    await window.getByRole("tab", { name: "파이프라인" }).click();
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

test("settings exposes supported Codex models and every reasoning effort", async () => {
  const { app, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "설정 열기" }).click();
    const dialog = window.getByRole("dialog", { name: "설정" });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByLabel("제공자", { exact: true })).toHaveText(
      "Codex 전용",
    );

    const model = dialog.getByLabel("모델", { exact: true });
    const models = [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ];
    await expect(model.locator("option")).toHaveText(models);
    for (const value of models) {
      await model.selectOption(value);
      await expect(model).toHaveValue(value);
    }

    const reasoning = dialog.getByLabel("추론 수준", { exact: true });
    const efforts = ["none", "low", "medium", "high", "xhigh", "max"];
    await expect(reasoning.locator("option")).toHaveText(efforts);
    for (const value of efforts) {
      await reasoning.selectOption(value);
      await expect(reasoning).toHaveValue(value);
    }

    await model.selectOption("gpt-5.6-terra");
    await reasoning.selectOption("xhigh");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(dialog).toBeHidden();

    await window.getByRole("button", { name: "설정 열기" }).click();
    const reopened = window.getByRole("dialog", { name: "설정" });
    await expect(reopened.getByLabel("모델", { exact: true })).toHaveValue(
      "gpt-5.6-terra",
    );
    await expect(
      reopened.getByLabel("추론 수준", { exact: true }),
    ).toHaveValue("xhigh");
  } finally {
    await cleanup();
  }
});

test("settings visual pipeline builder supports node connection editing", async () => {
  const { app, cleanup } = await launchIsolatedApp();
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    await window.getByRole("button", { name: "설정 열기" }).click();
    await expect(window.getByRole("dialog", { name: "설정" })).toBeVisible();
    await window.getByRole("tab", { name: "파이프라인" }).click();
    await window.getByRole("button", { name: "+ 새 파이프라인" }).click();

    const builder = window.locator(".pipeline-visual-builder");
    await expect(builder).toBeVisible();
    await builder.getByRole("button", { name: "+ node 추가" }).click();
    await builder.getByRole("button", { name: "+ node 추가" }).click();
    await builder.getByRole("button", { name: "그래프 창 열기" }).click();
    await expect(builder).toHaveClass(/pipeline-visual-builder--window/);

    await expect(builder.locator(".pipeline-visual__node")).toHaveCount(2);
    await expect(builder.locator(".pipeline-visual__graph")).toBeVisible();
    await expect(builder.locator(".pipeline-visual__edges")).toBeVisible();
    await expect(builder.locator(".pipeline-visual__link--dependency")).toHaveCount(1);

    const firstNode = builder.locator(".pipeline-visual__graph-node").first();
    const dragHandle = firstNode.locator(".pipeline-visual__graph-node-header");
    const beforeDrag = await firstNode.boundingBox();
    const handleBox = await dragHandle.boundingBox();
    expect(beforeDrag).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await window.mouse.move(handleBox!.x + 20, handleBox!.y + 12);
    await window.mouse.down();
    await window.mouse.move(handleBox!.x + 390, handleBox!.y + 230, { steps: 8 });
    await window.mouse.up();
    // Pointer events update React state asynchronously; assert the rendered position.
    await expect.poll(async () => (await firstNode.boundingBox())?.x ?? 0)
      .toBeGreaterThan(beforeDrag!.x + 280);
    await expect.poll(async () => (await firstNode.boundingBox())?.y ?? 0)
      .toBeGreaterThan(beforeDrag!.y + 150);

    const dependencyEdge = builder.locator(".pipeline-visual__edge.pipeline-visual__link--dependency").first();
    const edgeStyle = await dependencyEdge.evaluate((node) => {
      const style = window.getComputedStyle(node);
      const graph = document.querySelector(
        ".pipeline-visual__graph",
      ) as HTMLElement | null;
      const svg = document.querySelector(
        ".pipeline-visual__edges",
      ) as SVGSVGElement | null;
      const graphNodes = Array.from(
        document.querySelectorAll<HTMLElement>(".pipeline-visual__graph-node"),
      );
      const source = graphNodes[0];
      const target = graphNodes[1];
      const sourcePort = source?.querySelector(
        ".pipeline-visual__node-port--out",
      ) as HTMLElement | null | undefined;
      const targetPort = target?.querySelector(
        ".pipeline-visual__node-port--in",
      ) as HTMLElement | null | undefined;
      const graphBox = graph?.getBoundingClientRect();
      const sourcePortBox = sourcePort?.getBoundingClientRect();
      const targetPortBox = targetPort?.getBoundingClientRect();
      const start = node
        .getAttribute("d")
        ?.match(/M\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
      const end = node
        .getAttribute("d")
        ?.match(/,\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/);
      return {
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        startX: start ? Number(start[1]) : Number.NaN,
        startY: start ? Number(start[2]) : Number.NaN,
        endX: end ? Number(end[1]) : Number.NaN,
        endY: end ? Number(end[2]) : Number.NaN,
        preserveAspectRatio: svg?.getAttribute("preserveAspectRatio") ?? "",
        sourcePortX:
          graphBox && sourcePortBox
            ? sourcePortBox.left + sourcePortBox.width / 2 - graphBox.left
            : Number.NaN,
        sourcePortY:
          graphBox && sourcePortBox
            ? sourcePortBox.top + sourcePortBox.height / 2 - graphBox.top
            : Number.NaN,
        targetPortX:
          graphBox && targetPortBox
            ? targetPortBox.left + targetPortBox.width / 2 - graphBox.left
            : Number.NaN,
        targetPortY:
          graphBox && targetPortBox
            ? targetPortBox.top + targetPortBox.height / 2 - graphBox.top
            : Number.NaN,
      };
    });
    expect(edgeStyle.stroke).not.toBe("none");
    expect(Number.parseFloat(edgeStyle.strokeWidth)).toBeGreaterThanOrEqual(3);
    expect(edgeStyle.preserveAspectRatio).toBe("xMinYMin meet");
    expect(Math.abs(edgeStyle.startX - edgeStyle.sourcePortX)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(edgeStyle.startY - edgeStyle.sourcePortY)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(edgeStyle.endX - edgeStyle.targetPortX)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(edgeStyle.endY - edgeStyle.targetPortY)).toBeLessThanOrEqual(1.5);

    await builder.getByTitle("연결 삭제").click();
    await expect(builder.locator(".pipeline-visual__link--dependency")).toHaveCount(0);

    await builder.getByRole("button", { name: "의존 연결" }).click();
    const sourcePort = builder
      .locator(".pipeline-visual__graph-node")
      .nth(0)
      .locator(".pipeline-visual__node-port--out");
    const targetPort = builder
      .locator(".pipeline-visual__graph-node")
      .nth(1)
      .locator(".pipeline-visual__node-port--in");
    const sourceBox = await sourcePort.boundingBox();
    const targetBox = await targetPort.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    await window.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
    await window.mouse.down();
    await window.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
    await window.mouse.up();
    await expect(builder.locator(".pipeline-visual__link--dependency")).toHaveCount(1);
  } finally {
    await cleanup();
  }
});
