import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const answer = '# 복사 검수 ✅\n\n첫 번째 줄\n두 번째 줄\n\n```ts\nconst message = "한글";\nconsole.log(message);\n```\n\n[문서](https://example.com/docs)';

test("answers copy through real IPC, support selection, and retain copy feedback across languages", async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), "harness-copy-e2e-"));
  const userData = join(root, "userData");
  const targetDir = join(root, "project");
  mkdirSync(targetDir);
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
    // Preserve clipboard formats in the test process only, never in logs/artifacts.
    await app.evaluate(({ clipboard }) => {
      globalThis.copyClipboardBackup = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
    });
    const tasks = await page.evaluate(async targetDir => {
      const api = window.harness;
      const thread = await api.state.createThread({ title: "답변 복사 검수", targetDir });
      const ids = [];
      for (let n = 0; n < 2; n++) {
        const draft = await api.conversation.createTask({ threadId: thread.id, targetDir, mode: "agent", intent: "answer", userRequest: `설명해줘 ${n + 1}` });
        await api.agent.generatePlan({ taskRunId: draft.taskRun.id });
        ids.push(draft.taskRun.id);
      }
      return ids;
    }, targetDir);
    // Planning resolves before automatic quality/completion settles. Seed a
    // saved answer only after both canonical runs are terminal; a second DB
    // writer during markDone is not a copy UI regression.
    await expect.poll(() => page.evaluate(async ids => Promise.all(ids.map(async taskRunId =>
      (await window.harness.conversation.getTaskRunDetail({ taskRunId })).taskRun.status)), tasks))
      .toEqual(["done", "done"]);
    // Fixture data only: replace fake-model answers in this isolated DB, then
    // exercise the real saved-answer readers, renderer, preload, and clipboard.
    await app.evaluate(({ app }, { tasks, answer }) => {
      const path = process.getBuiltinModule("node:path");
      const load = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
      const db = new (load("better-sqlite3"))(path.join(app.getPath("userData"), "app.db"));
      try { db.transaction(() => {
        for (const id of tasks) {
          const invocation = db.prepare("SELECT raw_output_artifact_id, parsed_plan_artifact_id FROM agent_invocations WHERE task_run_id=?").get(id);
          for (const artifactId of [invocation.raw_output_artifact_id, invocation.parsed_plan_artifact_id]) {
            db.prepare("UPDATE artifacts SET summary=? WHERE id=?").run(answer, artifactId);
          }
        }
      }).immediate();
      } catch (error) { throw new Error(`Private copy fixture: ${error.code}: ${error.message}`); }
      finally { db.close(); }
      const {ipcMain,clipboard}=load("electron"),original=ipcMain._invokeHandlers.get("app:copyText");
      globalThis.__copyOutcomes=[];ipcMain.removeHandler("app:copyText");
      ipcMain.handle("app:copyText",async(...args)=>{const start=Date.now(),result=await original(...args);
        globalThis.__copyOutcomes.push({ok:result.ok,errorCode:result.error?.code,ms:Date.now()-start,matchesRequestedText:clipboard.readText()===args[1]?.text});return result;});
    }, { tasks, answer });
    await page.reload();
    await page.getByRole("button", { name: /답변 복사 검수/ }).click();
    await page.locator('.thread-task-flow__node[title="설명해줘 2"]').click();
    await expect(page.locator(".thread-task-flow__node--selected")).toBeVisible();
    const saved = page.locator(".chat-turn").filter({
      has: page.locator(".chat-bubble--user", { hasText: "설명해줘 1" }),
    }).locator(".inline-agent-stream--saved");
    await expect(saved.getByRole("button", { name: "답변 복사", exact: true })).toBeVisible();
    const selectedBefore = await page.locator(".thread-task-flow__node--selected").getAttribute("title");
    await saved.getByRole("button", { name: "답변 복사", exact: true }).click();
    await expect.poll(()=>app.evaluate(()=>globalThis.__copyOutcomes.length)).toBeGreaterThan(0);
    console.log("COPY_NATIVE",JSON.stringify(await app.evaluate(()=>globalThis.__copyOutcomes)));
    await expect(saved.getByRole("button", { name: "답변 복사", exact: true })).toContainText("복사됨");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
    expect(await page.locator(".thread-task-flow__node--selected").getAttribute("title")).toBe(selectedBefore);

    // Chromium's actual keyboard copy uses the selected rendered text, not the
    // Markdown source copied by the button. No clipboard-read API is exposed.
    const paragraph = saved.locator(".markdown-text p").first();
    await expect(paragraph).toHaveCSS("user-select", "text");
    await paragraph.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    const selectedText = await page.evaluate(() => window.getSelection().toString());
    await page.keyboard.press("Control+c");
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(selectedText);
    await page.evaluate(() => window.getSelection().removeAllRanges());

    const current = page.locator(".chat-turn--selected .inline-agent-stream__section--final").first();
    const copy = current.getByRole("button", { name: "답변 복사", exact: true });
    await copy.focus();
    await page.keyboard.press("Enter");
    await expect(copy).toContainText("복사됨");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
    await page.getByRole("button", { name: "Switch to English", exact: true }).click();
    await expect(current.getByRole("button", { name: "Copy answer", exact: true })).toContainText("Copied");

    // Simulate an OS clipboard failure, and verify the original handler's error
    // crosses preload correctly and the user can retry successfully.
    await app.evaluate(({ clipboard }) => {
      globalThis.copyOriginalWriteText = clipboard.writeText;
      clipboard.writeText = () => { throw new Error("test clipboard unavailable"); };
    });
    await current.getByRole("button", { name: "Copy answer", exact: true }).click();
    await expect(current.getByRole("alert")).toContainText("Could not copy");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(answer);
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.copyOriginalWriteText; });
    await current.getByRole("button", { name: "Copy answer", exact: true }).click();
    await expect(current.getByRole("alert")).toHaveCount(0);
    await expect(current.getByRole("button", { name: "Copy answer", exact: true })).toContainText("Copied");

    for (const input of [{ text: 42 }, { text: " " }, { text: "x\0y" }]) {
      expect(await page.evaluate(async input => {
        try { await window.harness.app.copyText(input); return "unexpected success"; }
        catch (error) { return error.message; }
      }, input)).toContain("IPC_INVALID_PAYLOAD");
    }
    expect(await page.evaluate(() => "readText" in window.harness.app)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("answer-copy.png") });
  } finally {
    if (app) {
      try {
        await app.evaluate(({ clipboard }, answer) => {
          if (globalThis.copyOriginalWriteText) clipboard.writeText = globalThis.copyOriginalWriteText;
          // Do not overwrite anything the user copied while the test ran.
          if (clipboard.readText() === answer && globalThis.copyClipboardBackup) {
            clipboard.clear();
            for (const [format, buffer] of globalThis.copyClipboardBackup) clipboard.writeBuffer(format, buffer);
          }
        }, answer);
      } finally { await app.close(); }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
