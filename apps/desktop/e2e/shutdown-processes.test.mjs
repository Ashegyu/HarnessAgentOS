import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopOwned = pid => {
  if (!pid || !alive(pid)) return;
  try { execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 }); } catch { /* Best-effort fixture cleanup only. */ }
};

for (const closeVia of ["window", "quit"]) {
  test(`app ${closeVia} drains an approved Runner process tree without killing an unrelated Node`, async () => {
    test.skip(process.platform !== "win32", "Windows process-tree ownership regression");
    test.setTimeout(45000);
    const root = mkdtempSync(join(tmpdir(), "harness-shutdown-e2e-"));
    const target = join(root, "project"); mkdirSync(target);
    const marker = join(target, "owned-pids.json");
    const fixture = join(target, "owned.cjs");
    writeFileSync(fixture, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
child.on('spawn',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid})));
setInterval(()=>{},1000);`);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
    const userData = join(root, "data");
    const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
    const launch = () => electron.launch({ args: ["--no-sandbox", ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]), `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
    let app, restarted, pids;
    try {
      app = await launch();
      const page = await app.firstWindow();
      const draft = await page.evaluate(async targetDir => {
        const thread = await window.harness.state.createThread({ title: "shutdown ownership", targetDir });
        return window.harness.conversation.createTask({ threadId: thread.id, targetDir, intent: "change", userRequest: "실제 검사 명령 실행", mode: "template" });
      }, target);
      const approvalId = draft.approvals[0].id;
      // Seed only the action kind in a private fixture DB. Revision, consent,
      // claim, shell spawning and completion all use the actual typed IPC path.
      await app.evaluate(({ app }, id) => {
        const path = process.getBuiltinModule("node:path");
        const load = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
        const db = new (load("better-sqlite3"))(path.join(app.getPath("userData"), "app.db"));
        try { db.prepare("UPDATE approvals SET action_type='shell' WHERE id=? AND status='pending'").run(id); } finally { db.close(); }
      }, approvalId);
      await page.evaluate(async ({ approvalId, command, fixture }) => {
        const approval = await window.harness.conversation.setProposedAction({ approvalId, details: { type: "shell", command, args: [fixture] } });
        await window.harness.conversation.approve({ approvalId, expectedRevision: approval.actionRevision, manualConfirmation: true });
      }, { approvalId, command: process.execPath, fixture });
      await expect.poll(() => existsSync(marker), { timeout: 12000 }).toBe(true);
      pids = JSON.parse(readFileSync(marker, "utf8"));
      expect(alive(pids.parent) && alive(pids.child)).toBe(true);
      const closed = new Promise(resolve => app.process().once("exit", resolve));
      await app.evaluate(({ app, BrowserWindow }, closeVia) => { if (closeVia === "quit") app.quit(); else BrowserWindow.getAllWindows()[0].close(); }, closeVia).catch(() => {});
      await closed;
      await expect.poll(() => [alive(pids.parent), alive(pids.child)], { timeout: 5000 }).toEqual([false, false]);
      expect(alive(unrelated.pid)).toBe(true);
      restarted = await launch();
      const detail = await (await restarted.firstWindow()).evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), draft.taskRun.id);
      // Killing a shell does not prove rollback of partial effects. Preserve
      // the existing uncertain/review policy, but finish its execution record.
      expect(detail.approvals.find(a => a.id === approvalId).executionState).toBe("uncertain");
      expect(detail.approvals.find(a => a.id === approvalId).executionFinishedAt).toBeTruthy();
      expect(detail.steps.some(step => step.status === "running")).toBe(false);
      const retry = await (await restarted.firstWindow()).evaluate(async ({ approvalId, revision }) => window.harness.conversation.prepareActionRetry({
        approvalId, expectedRevision: revision, expectedExecutionState: "uncertain", reviewMessage: "종료 중 부분 실행 결과를 확인했으며 수동 재승인을 준비합니다.",
      }), { approvalId, revision: detail.approvals.find(a => a.id === approvalId).actionRevision });
      expect(detail.taskRun.status).toBe("blocked");
      expect(retry.status).toBe("pending");
      const reviewed = await (await restarted.firstWindow()).evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), draft.taskRun.id);
      expect(reviewed.approvals.find(a => a.id === approvalId).executionState).toBe("uncertain");
      expect(reviewed.taskRun.status).toBe("waiting_for_approval");
      expect(existsSync(marker) && !alive(pids.parent) && !alive(pids.child)).toBe(true);
    } finally {
      if (!pids && existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8"));
      if (pids) { stopOwned(pids.parent); stopOwned(pids.child); }
      stopOwned(unrelated.pid);
      if (restarted) await restarted.close().catch(() => {});
      if (app) await app.close().catch(() => {});
      if (resolve(root).startsWith(resolve(tmpdir()) + sep)) rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["pipeline", "planner"]) {
  test(`quit drains a real CLI ${kind} tree and preserves explicit recovery`, async () => {
    test.skip(process.platform !== "win32", "Windows CLI ownership regression");
    const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
    test.skip(!existsSync(compiler), "Fixture compiler is not installed");
    test.setTimeout(45000);
    const root = mkdtempSync(join(tmpdir(), "harness-worker-shutdown-"));
    const target = join(root, "project"); mkdirSync(target);
    const marker = join(target, "worker-pids.json"), starts = join(target, "worker-starts.txt");
    const script = join(target, "tree.cjs"), source = join(root, "Fixture.cs"), cli = join(root, "codex.exe");
    writeFileSync(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  child.on('spawn',()=>{fs.appendFileSync(${JSON.stringify(starts)},'started\\n');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid,worker:Number(process.argv[2]),schema:process.argv[3]}));});setInterval(()=>{},1000);`);
    const cs = value => '@"' + value.replaceAll('"', '""') + '"';
    writeFileSync(source, `using System;using System.Diagnostics;using System.Threading;
  class Fixture {static void Main(string[] args){
  if(Array.IndexOf(args,"--version")>=0){Console.WriteLine("codex-cli 0.153.4");return;}
  if(Array.IndexOf(args,"--help")>=0){Console.WriteLine("  --output-schema <FILE>    --json");return;}
  if(Array.IndexOf(args,"mcp")>=0){Console.WriteLine("[]");return;}
  int i=Array.IndexOf(args,"--output-schema");string schema=i>=0?args[i+1]:"";
  var p=new ProcessStartInfo(${cs(process.execPath)},"\\\""+${cs(script)}+"\\\" "+Process.GetCurrentProcess().Id+" \\\""+schema+"\\\"");p.UseShellExecute=false;p.CreateNoWindow=true;Process.Start(p);
  for(;;){Console.WriteLine("fixture alive");Thread.Sleep(1000);}}}`);
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${cli}`, source], { windowsHide: true, timeout: 15000 });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
    const userData = join(root, "data");
    const env = { ...process.env, PATH: `${root};${process.env.PATH}`, HARNESS_E2E_USER_DATA: userData, HARNESS_ORCHESTRATION_ENABLED: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.HARNESS_E2E_FAKE_AGENT;
    const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
    const launch = () => electron.launch({ args: ["--no-sandbox", ...(executablePath ? [] : [join(dirname(fileURLToPath(import.meta.url)), "../out/main/main.js")]), `--user-data-dir=${userData}`], env, ...(executablePath ? { executablePath } : {}) });
    let app, restarted, pids, appProcess;
    try {
      app = await launch();
      appProcess = app.process();
      const page = await app.firstWindow();
      const task = await page.evaluate(async ({ target, cli, kind }) => {
        const api = window.harness, settings = await api.settings.get();
        await api.settings.update({ ...settings, approval: { ...settings.approval, autoApprove: false }, orchestration: { ...settings.orchestration, enabled: true } });
        const baseline = (await api.agents.list())[0];
        const { id, createdAt, updatedAt, ...profileInput } = baseline;
        const profile = await api.agents.create({ profile: { ...profileInput, name: "Owned shutdown fixture", role: "reviewer", isDefault: false,
          cli: { ...profileInput.cli, cliPathOverride: cli },
          permissions: { autoApproveActions: [], blockedActions: [], allowedSkillIds: [], toolAllowlist: [], toolDenylist: [] },
          mcpServerIds: [], skillSourceIds: [], tuning: { ...profileInput.tuning, timeoutMs: 120000, stallTimeoutMs: 120000 } } });
        await api.agents.setActive({ profileId: profile.id });
        const pipeline = await api.pipeline.create({ pipeline: { name: "Shutdown fixture pipeline", description: "", steps: [0,1].map(i => ({
          id: `owned-${i}`, title: `Owned worker ${i}`, agentProfileId: profile.id, instruction: "Inspect the fixture", expectedArtifactKinds: ["log"], allowedActions: [], dependsOn: i ? ["owned-0"] : [],
        })) } });
        const thread = await api.state.createThread({ title: "Worker shutdown", targetDir: target });
        const draft = await api.conversation.createTask({ threadId: thread.id, targetDir: target, intent: "change", userRequest: "코드를 수정해줘", mode: "agent" }).catch(e => { throw new Error(`fixture createTask: ${e.message}`); });
        if (kind === "planner") {
          void api.agent.generatePlan({ taskRunId: draft.taskRun.id }).catch(() => {});
          return { id: draft.taskRun.id };
        }
        const orchestration = await api.orchestration.draftPlan({ taskRunId: draft.taskRun.id, mode: "multi_worker", pipelineId: pipeline.id }).catch(e => { throw new Error(`fixture draftPlan: ${e.message}`); });
        // Selecting a saved pipeline is the existing pipeline-consent path;
        // main progression owns approving its parent and starting the worker.
        return { id: draft.taskRun.id, approvalId: orchestration.approval.id };
      }, { target, cli, kind });
      await expect.poll(() => existsSync(marker), { timeout: 15000 }).toBe(true);
      pids = JSON.parse(readFileSync(marker, "utf8"));
      expect(pids.schema).toBeTruthy(); expect(existsSync(pids.schema)).toBe(true);
      expect([pids.worker,pids.parent,pids.child].every(alive)).toBe(true);
      if (kind === "planner") await app.evaluate(({ app }, taskRunId) => {
        // A historical pipeline approval must not hide today's standalone
        // planner owner or strand its explicit retry behind Pause.
        const path = process.getBuiltinModule("node:path");
        const load = process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(), "package.json"));
        const db = new (load("better-sqlite3"))(path.join(app.getPath("userData"), "app.db"));
        try {
          const step = db.prepare("SELECT step_id FROM agent_invocations WHERE task_run_id=? AND status='running'").get(taskRunId);
          db.prepare("INSERT INTO checkpoints(id,task_run_id,step_id,reason,state_ref,summary,created_at) VALUES ('historical-checkpoint',?,?,'before_edit','{}','Historical pipeline',?)").run(taskRunId, step.step_id, new Date().toISOString());
          db.prepare("INSERT INTO approvals(id,task_run_id,checkpoint_id,action_type,action_summary,status) VALUES ('historical-parent',?,'historical-checkpoint','orchestration_plan','Historical parent','approved')").run(taskRunId);
        } finally { db.close(); }
      }, task.id);
      void app.evaluate(({ app }) => app.quit()).catch(() => {});
      await expect.poll(() => [pids.worker,pids.parent,pids.child].map(alive), { timeout: 8000 }).toEqual([false,false,false]);
      await expect.poll(() => appProcess.exitCode !== null, { timeout: 10000 }).toBe(true);
      expect(alive(unrelated.pid)).toBe(true); expect(existsSync(pids.schema)).toBe(false);
      restarted = await launch();
      const detail = await (await restarted.firstWindow()).evaluate(id => window.harness.conversation.getTaskRunDetail({ taskRunId: id }), task.id);
      expect(detail.taskRun.status).toBe(kind === "pipeline" ? "paused" : "blocked");
      expect(detail.agentInvocations).toHaveLength(1); expect(detail.agentInvocations[0].status).toBe("cancelled");
      if (kind === "pipeline") expect(detail.approvals.find(a => a.id === task.approvalId).status).toBe("approved");
      expect(detail.steps.some(s => s.status === "running")).toBe(false);
      expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
      if (kind === "planner") {
        const restartPage = await restarted.firstWindow();
        void restartPage.evaluate(id => window.harness.agent.retryInvocation({ invocationId: id }), detail.agentInvocations[0].id).catch(() => {});
        await expect.poll(() => readFileSync(starts, "utf8").trim().split("\n").length, { timeout: 15000 }).toBe(2);
        pids = JSON.parse(readFileSync(marker, "utf8"));
        expect([pids.worker,pids.parent,pids.child].every(alive)).toBe(true);
        const restartedProcess = restarted.process();
        void restarted.evaluate(({ app }) => app.quit()).catch(() => {});
        await expect.poll(() => [pids.worker,pids.parent,pids.child].map(alive), { timeout: 8000 }).toEqual([false,false,false]);
        await expect.poll(() => restartedProcess.exitCode !== null, { timeout: 10000 }).toBe(true);
        expect(existsSync(pids.schema)).toBe(false);
      }
    } finally {
      if (!pids && existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8"));
      if (pids) for (const pid of [pids.worker,pids.parent,pids.child]) stopOwned(pid);
      stopOwned(unrelated.pid);
      if (restarted) await restarted.close().catch(() => {});
      if (appProcess && appProcess.exitCode === null) stopOwned(appProcess.pid);
      if (app) await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
      if (resolve(root).startsWith(resolve(tmpdir()) + sep)) rmSync(root, { recursive: true, force: true });
    }
  });
}
