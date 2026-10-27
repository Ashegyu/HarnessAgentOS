import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

test("command history and notification bursts keep IPC work bounded and publish fresh results", async () => {
  const root=mkdtempSync(join(tmpdir(),"harness-load-ui-"));
  const env={...process.env,HARNESS_E2E_USER_DATA:join(root,"data"),HARNESS_E2E_FAKE_AGENT:"1"};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.HARNESS_E2E_EXECUTABLE;
  const app=await electron.launch({args:["--no-sandbox",...(executablePath?[]:[join(dirname(fileURLToPath(import.meta.url)),"../out/main/main.js")]),`--user-data-dir=${join(root,"data")}`],env,...(executablePath?{executablePath}:{})});
  try {
    const page=await app.firstWindow();
    await page.getByRole("main",{name:"Conversation workbench"}).waitFor();
    expect(await app.evaluate(({app})=>app.getPath("userData"))).toBe(join(root,"data"));
    await app.evaluate(({app})=>{
      const path=process.getBuiltinModule("node:path"), load=process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(),"package.json"));
      const db=new(load("better-sqlite3"))(path.join(app.getPath("userData"),"app.db"));
      try {db.transaction(()=>{
        const thread=db.prepare("INSERT INTO threads(id,title,created_at,updated_at) VALUES (?,?,?,?)");
        const task=db.prepare("INSERT INTO task_runs(id,thread_id,user_request,target_dir,status,created_at,updated_at) VALUES (?,?,?,'C:/fixture','blocked',?,?)");
        for(let i=0;i<40;i++) {const time=new Date(Date.UTC(2026,0,1)+i*1000).toISOString();thread.run(`load-thread-${i}`,`History ${i}`,time,time);task.run(`load-task-${i}`,`load-thread-${i}`,`Historical request ${i}`,time,time);}
      })();} finally {db.close();}
      const {ipcMain}=load("electron");
      // Test-only observation of real registered handlers; no product channel.
      const metrics={calls:{},active:0,maxActive:0,bytes:0};globalThis.__loadMetrics=metrics;
      for(const channel of ["state:getThread","state:listRecentTaskRuns","conversation:getTaskRunDetail","quality:getLatest"]) {
        const original=ipcMain._invokeHandlers.get(channel);if(!original)continue;
        ipcMain.removeHandler(channel);ipcMain.handle(channel,async (...args)=>{
          metrics.calls[channel]=(metrics.calls[channel]??0)+1;
          if(channel==="conversation:getTaskRunDetail") {metrics.active++;metrics.maxActive=Math.max(metrics.maxActive,metrics.active);}
          try {const result=await original(...args);if(channel==="conversation:getTaskRunDetail")await new Promise(r=>setTimeout(r,30));metrics.bytes+=Buffer.byteLength(JSON.stringify(result));return result;}
          finally {if(channel==="conversation:getTaskRunDetail")metrics.active--;}
        });
      }
    });
    await page.reload();await page.getByRole("main",{name:"Conversation workbench"}).waitFor();
    await page.keyboard.press("Control+k");
    await expect(page.locator(".command-palette")).toBeVisible();
    await expect.poll(()=>app.evaluate(()=>Object.values(globalThis.__loadMetrics.calls).reduce((a,b)=>a+b,0))).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    const history=await app.evaluate(()=>structuredClone(globalThis.__loadMetrics));
    // Assert work, not noisy elapsed-time thresholds.
    await app.evaluate(({BrowserWindow})=>{
      const m=globalThis.__loadMetrics;m.calls={};m.active=0;m.maxActive=0;m.bytes=0;
      for(let i=0;i<100;i++)BrowserWindow.getAllWindows()[0].webContents.send("events:taskRunChanged",{taskRunId:"load-task-0"});
    });
    await expect.poll(()=>app.evaluate(()=>globalThis.__loadMetrics.calls["conversation:getTaskRunDetail"]??0)).toBeGreaterThan(0);
    await expect.poll(()=>app.evaluate(()=>globalThis.__loadMetrics.active)).toBe(0);
    const burst=await app.evaluate(()=>structuredClone(globalThis.__loadMetrics));
    if(process.env.HARNESS_LOAD_UI_METRICS)writeFileSync(process.env.HARNESS_LOAD_UI_METRICS,JSON.stringify({history,burst},null,2));
    expect(history.calls["state:getThread"]??0).toBe(0);
    expect(history.calls["state:listRecentTaskRuns"]).toBe(1);
    expect(burst.maxActive).toBe(1);expect(burst.calls["conversation:getTaskRunDetail"]).toBeLessThanOrEqual(2);
    expect(burst.calls["quality:getLatest"]??0).toBe(0);
    await app.evaluate(({BrowserWindow})=>{
      const m=globalThis.__loadMetrics;m.calls={};m.maxActive=0;
      for(let i=1;i<=15;i++)BrowserWindow.getAllWindows()[0].webContents.send("events:taskRunChanged",{taskRunId:`load-task-${i}`});
    });
    await expect.poll(()=>app.evaluate(()=>globalThis.__loadMetrics.calls["conversation:getTaskRunDetail"]??0)).toBe(15);
    await expect.poll(()=>app.evaluate(()=>globalThis.__loadMetrics.active)).toBe(0);
    const distinct=await app.evaluate(()=>structuredClone(globalThis.__loadMetrics));
    expect(distinct.maxActive).toBeLessThanOrEqual(4);
    await app.evaluate(({app,BrowserWindow})=>{
      const path=process.getBuiltinModule("node:path"),load=process.getBuiltinModule("node:module").createRequire(path.join(app.getAppPath(),"package.json"));
      const db=new(load("better-sqlite3"))(path.join(app.getPath("userData"),"app.db"));try{db.prepare("UPDATE task_runs SET status='cancelled' WHERE id='load-task-0'").run();}finally{db.close();}
      BrowserWindow.getAllWindows()[0].webContents.send("events:taskRunChanged",{taskRunId:"load-task-0"});
    });
    await page.getByRole("button",{name:/Notifications|알림/,exact:true}).click();
    await expect(page.getByText("TaskRun cancelled",{exact:true})).toBeVisible();
    for(const limit of [0,101,"10"]) expect(await page.evaluate(async limit=>window.harness.state.listRecentTaskRuns({limit}).then(()=>"unexpected success",e=>e.message),limit)).toContain("STATE_INVALID_INPUT");
    if(process.env.HARNESS_LOAD_UI_METRICS)writeFileSync(process.env.HARNESS_LOAD_UI_METRICS,JSON.stringify({history,burst,distinct},null,2));
  } finally {await app.close();if(resolve(root).startsWith(resolve(tmpdir())+sep))rmSync(root,{recursive:true,force:true});}
});
