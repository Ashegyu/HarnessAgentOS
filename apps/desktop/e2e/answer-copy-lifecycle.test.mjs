import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

for (const outcome of ["success", "error"]) {
test(`copy waits for the selected view to settle (${outcome}) and keeps the same task identity`, async () => {
  const root=mkdtempSync(join(tmpdir(),"harness-copy-lifetime-")), userData=join(root,"data"), targetDir=join(root,"project");
  mkdirSync(targetDir);
  const answers=["# 이전 작업의 답변\n\n복사 수명 회귀 ✅", "# 새 작업의 다른 답변\n\n잘못된 버튼 선택을 구분합니다."];
  const env={...process.env,HARNESS_E2E_USER_DATA:userData,HARNESS_E2E_FAKE_AGENT:"1"};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.HARNESS_E2E_EXECUTABLE;
  let app;
  try {
    app=await electron.launch({args:["--no-sandbox",...(executablePath?[]:[join(dirname(fileURLToPath(import.meta.url)),"../out/main/main.js")]),`--user-data-dir=${userData}`],env,...(executablePath?{executablePath}:{})});
    expect(await app.evaluate(({app})=>app.getPath("userData"))).toBe(userData);
    const page=await app.firstWindow();await page.getByRole("main",{name:"Conversation workbench"}).waitFor();
    await app.evaluate(({clipboard})=>{globalThis.__copyBackup=clipboard.availableFormats().map(f=>[f,clipboard.readBuffer(f)]);});
    const tasks=await page.evaluate(async targetDir=>{
      const api=window.harness,thread=await api.state.createThread({title:"복사 수명 회귀",targetDir}),ids=[];
      for(const userRequest of ["이전 작업", "새 작업"]) {const d=await api.conversation.createTask({threadId:thread.id,targetDir,mode:"agent",intent:"answer",userRequest});await api.agent.generatePlan({taskRunId:d.taskRun.id});ids.push(d.taskRun.id);}
      return ids;
    },targetDir);
    await expect.poll(()=>page.evaluate(async ids=>Promise.all(ids.map(async taskRunId=>
      (await window.harness.conversation.getTaskRunDetail({taskRunId})).taskRun.status)),tasks))
      .toEqual(["done","done"]);
    await app.evaluate(({app},{tasks,answers,outcome})=>{
      const path=process.getBuiltinModule("node:path"),load=process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(),"package.json"));
      const db=new(load("better-sqlite3"))(path.join(app.getPath("userData"),"app.db"));
      try {db.transaction(()=>{for(let i=0;i<tasks.length;i++){const r=db.prepare("SELECT raw_output_artifact_id,parsed_plan_artifact_id FROM agent_invocations WHERE task_run_id=?").get(tasks[i]);for(const id of [r.raw_output_artifact_id,r.parsed_plan_artifact_id])db.prepare("UPDATE artifacts SET summary=? WHERE id=?").run(answers[i],id);}}).immediate();}
      catch(error){throw new Error(`Private copy fixture: ${error.code}: ${error.message}`);}
      finally{db.close();}
      const {ipcMain}=load("electron"),detail=ipcMain._invokeHandlers.get("conversation:getTaskRunDetail"),copy=ipcMain._invokeHandlers.get("app:copyText");
      const state={detailEntered:false,copyCalls:0,copySucceeded:false};globalThis.__copyLifetime=state;
      const gate=new Promise(r=>{state.releaseDetail=r;}),copyGate=new Promise(r=>{state.releaseCopy=r;});
      ipcMain.removeHandler("conversation:getTaskRunDetail");ipcMain.handle("conversation:getTaskRunDetail",async(...args)=>{const value=await detail(...args);if(args[1]?.taskRunId===tasks[0]){state.detailEntered=true;await gate;if(outcome==="error")return{ok:false,error:{code:"STATE_DB_ERROR",message:"fixture detail unavailable"}};}return value;});
      ipcMain.removeHandler("app:copyText");ipcMain.handle("app:copyText",async(...args)=>{state.copyCalls++;const value=await copy(...args);state.copySucceeded=value.ok;state.copySettled=true;state.errorCode=value.error?.code;await copyGate;return value;});
    },{tasks,answers,outcome});
    await page.reload();await page.getByRole("button",{name:/복사 수명 회귀/}).click();
    // Bind both the selection and the observed answer to the same task.
    // Global saved-answer positions change when the selected view hydrates.
    const turn=page.locator(".chat-turn").filter({has:page.locator(".chat-bubble--user",{hasText:"이전 작업"})});
    const other=page.locator(".chat-turn").filter({has:page.locator(".chat-bubble--user",{hasText:"새 작업"})});
    await page.locator('.thread-task-flow__node[title="이전 작업"]').click();
    await expect.poll(()=>app.evaluate(()=>globalThis.__copyLifetime.detailEntered)).toBe(true);
    const saved=turn.locator(".inline-agent-stream--saved .answer-copy__button");await expect(saved).toBeVisible();
    await expect(other.locator(".answer-copy__button")).toBeEnabled();
    const oldNode=await saved.elementHandle();
    // A disabled native button must reject even a scripted click. On the old
    // implementation this admits the copy just before destroying its owner.
    await saved.evaluate(button=>button.click());
    const admitted=await app.evaluate(()=>globalThis.__copyLifetime.copyCalls);
    if(admitted)await expect.poll(()=>app.evaluate(()=>globalThis.__copyLifetime.copySucceeded)).toBe(true);
    await app.evaluate(()=>globalThis.__copyLifetime.releaseDetail());
    if(outcome==="success")await expect(turn.locator(".inline-agent-stream-stack .answer-copy__button")).toBeVisible();
    else await expect(turn.locator(".answer-copy__button")).toBeEnabled();
    await app.evaluate(()=>globalThis.__copyLifetime.releaseCopy());
    const disconnected=await oldNode.evaluate(node=>!node.isConnected);
    console.log("COPY_LIFETIME",JSON.stringify({admittedBeforeDetail:admitted,obsoleteButtonDisconnected:disconnected,
      nativeCopySucceeded:await app.evaluate(()=>globalThis.__copyLifetime.copySucceeded),
      replacementFeedback:await turn.locator(".answer-copy__button").innerText()}));
    expect(admitted).toBe(0);
    const current=turn.locator(".answer-copy__button");await expect(current).toBeEnabled();
    await current.evaluate(button=>{button.click();button.click();});
    await expect.poll(()=>app.evaluate(()=>globalThis.__copyLifetime.copySettled)).toBe(true);
    console.log("COPY_NATIVE",JSON.stringify(await app.evaluate(()=>{const s=globalThis.__copyLifetime;return{copyCalls:s.copyCalls,ok:s.copySucceeded,code:s.errorCode};})));
    await expect(current).toContainText("복사됨");
    expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(answers[0]);
    expect(await app.evaluate(()=>globalThis.__copyLifetime.copyCalls)).toBe(1);
    await page.getByRole("button",{name:"Switch to English",exact:true}).click();await expect(current).toContainText("Copied");
  } finally {
    if(app){await app.evaluate(({clipboard},answers)=>{globalThis.__copyLifetime?.releaseDetail();globalThis.__copyLifetime?.releaseCopy();if(answers.includes(clipboard.readText())&&globalThis.__copyBackup){clipboard.clear();for(const[f,b]of globalThis.__copyBackup)clipboard.writeBuffer(f,b);}},answers).catch(()=>{});await app.close();}
    if(resolve(root).startsWith(resolve(tmpdir())+sep))rmSync(root,{recursive:true,force:true});
  }
});
}
