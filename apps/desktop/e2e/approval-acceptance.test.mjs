import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const main = join(dirname(fileURLToPath(import.meta.url)), '../out/main/main.js');
const executablePath = process.env.HARNESS_E2E_EXECUTABLE;
async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-approval-e2e-'));
  const target = join(dir, 'target');
  const userData = join(dir, 'userData');
  mkdirSync(target);
  const env = { ...process.env, HARNESS_E2E_USER_DATA: userData, HARNESS_E2E_FAKE_AGENT: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', ...(executablePath ? [] : [main]), `--user-data-dir=${userData}`], env,
    ...(executablePath ? { executablePath } : {}) });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', {name:'새 작업',exact:true})).toBeVisible();
  return { app, page, dir, target, close: async () => { await app.close(); rmSync(dir,{recursive:true,force:true}); } };
}

async function seed(f, action, title = '승인 검수') {
  const draft = await f.page.evaluate(async ({target, title}) => {
    const thread = await window.harness.state.createThread({ title, targetDir:target });
    return window.harness.conversation.createTask({threadId:thread.id,targetDir:target,userRequest:'검수 파일 수정',intent:'change',mode:'template'});
  }, {target:f.target,title});
  const id = draft.approvals[0].id;
  // Fixture creation only: isolated userData DB, then all consent/effects use real IPC.
  await f.app.evaluate(({app}, {id,action}) => {
    const path = process.getBuiltinModule('node:path');
    const load = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
    const db = new (load('better-sqlite3'))(path.join(app.getPath('userData'),'app.db'));
    try { db.prepare('UPDATE approvals SET action_type=?,proposed_action_json=?,policy_evaluation_json=NULL WHERE id=?').run(action.type,JSON.stringify(action),id); }
    finally { db.close(); }
  }, {id,action});
  return {id,taskRunId:draft.taskRun.id,title};
}
const approve = (f, a, manualConfirmation = true) => f.page.evaluate(async ({a,manualConfirmation}) => {
  const detail = await window.harness.conversation.getTaskRunDetail({taskRunId:a.taskRunId});
  const approval = detail.approvals.find(row => row.id === a.id);
  return window.harness.conversation.approve({approvalId:a.id,expectedRevision:approval.actionRevision,manualConfirmation});
}, {a,manualConfirmation});
async function waitExecution(f, a) {
  await expect.poll(async () => {
    const d = await f.page.evaluate(taskRunId => window.harness.conversation.getTaskRunDetail({taskRunId}), a.taskRunId);
    return d.approvals.find(row => row.id === a.id).executionState;
  }, {timeout:15000}).toBe('succeeded');
  const d = await f.page.evaluate(taskRunId => window.harness.conversation.getTaskRunDetail({taskRunId}), a.taskRunId);
  const log = d.artifacts.find(row => row.kind === 'log' && d.steps.some(s => s.id === row.stepId && ['shell','test'].includes(s.kind)));
  if (!log) return null;
  const {content} = await f.page.evaluate(artifactId => window.harness.runner.readArtifact({artifactId}), log.id);
  expect(content).toContain('# exit=0');
  return content.split('## stdout\n\n')[1]?.split('\n\n## stderr')[0] ?? '';
}
const execute = (f, a) => f.page.evaluate(id => window.harness.runner.executeApproved({approvalId:id}), a.id);
async function card(f, a) {
  await f.page.reload();
  await f.page.getByRole('button',{name:new RegExp(a.title)}).click();
  await f.page.locator('.chat-turn').click();
  await f.page.locator('#right-panel-tab-plan').click();
  return f.page.locator(`#approval-card-${a.id}`);
}

test('real approval UI creates a file; revised consent, rejection, and duplicate execution are guarded', async () => {
  const f = await launch();
  try {
    const a = await seed(f,{type:'file_write',filePatch:{path:'A.txt',after:'A'}});
    await expect(execute(f,a)).rejects.toThrow();
    const ui = await card(f,a);
    expect(existsSync(join(f.target,'A.txt'))).toBe(false);
    // Simulate an approved old revision without dispatching execution. The
    // real setProposedAction IPC below must revoke it before any side effect.
    await f.app.evaluate(({app}, id) => {
      const path = process.getBuiltinModule('node:path');
      const load = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
      const db = new (load('better-sqlite3'))(path.join(app.getPath('userData'),'app.db'));
      try { db.prepare("UPDATE approvals SET status='approved',approved_revision=action_revision WHERE id=?").run(id); }
      finally { db.close(); }
    }, a.id);
    await f.page.evaluate(id => window.harness.conversation.setProposedAction({approvalId:id,details:{type:'file_write',filePatch:{path:'B.txt',after:'B'}}}),a.id);
    await expect(execute(f,a)).rejects.toThrow();
    await expect(f.page.evaluate(id => window.harness.conversation.approve({approvalId:id,expectedRevision:1,manualConfirmation:true}),a.id)).rejects.toThrow(/REVISION/);
    await expect(f.page.evaluate(id => window.harness.conversation.approve({approvalId:id,expectedRevision:2,autoApproveDecision:{approved:true,decidedAt:'global_toggle',reason:'test'}}),a.id)).rejects.toThrow(/MANUAL/);
    await ui.getByRole('checkbox').check();
    await ui.getByRole('button',{name:'승인 후 실행',exact:true}).click();
    await waitExecution(f,a);
    const results = await f.page.evaluate(id => Promise.allSettled(Array.from({length:20},()=>window.harness.runner.executeApproved({approvalId:id}))),a.id);
    expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(0);
    const afterRun = await f.page.evaluate(taskRunId=>window.harness.conversation.getTaskRunDetail({taskRunId}),a.taskRunId);
    expect(afterRun.steps.filter(s=>s.kind==='edit' && s.status==='succeeded')).toHaveLength(1);
    expect(readFileSync(join(f.target,'B.txt'),'utf8')).toBe('B');
    expect(existsSync(join(f.target,'A.txt'))).toBe(false);
    const modify = await seed(f,{type:'file_write',filePatch:{path:'B.txt',before:'B',after:'B2\n'}},'파일 수정 검수');
    await approve(f,modify);
    await waitExecution(f,modify);
    const patch = await seed(f,{type:'file_patch',unifiedPatch:{path:'B.txt',patch:'--- a/B.txt\n+++ b/B.txt\n@@ -1 +1 @@\n-B2\n+B3\n'}},'파일 패치 검수');
    await approve(f,patch);
    await waitExecution(f,patch);
    expect(readFileSync(join(f.target,'B.txt'),'utf8')).toBe('B3\n');
    const reject = await seed(f,{type:'file_write',filePatch:{path:'never.txt',after:'no'}},'거절 검수');
    const rejectedCard = await card(f,reject);
    await rejectedCard.getByRole('button',{name:'거절',exact:true}).click();
    await rejectedCard.getByPlaceholder('거절 이유 (필수)').fill('검수용 거절');
    await rejectedCard.getByRole('button',{name:'거절 확정',exact:true}).click();
    await expect(execute(f,reject)).rejects.toThrow();
    await expect(approve(f,reject)).rejects.toThrow();
    expect(existsSync(join(f.target,'never.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('real host CLI requires manual consent, preserves argv, and runs installed npm check/test', async () => {
  test.setTimeout(60000);
  const f = await launch();
  try {
    writeFileSync(join(f.target,'package.json'),JSON.stringify({scripts:{check:'node -e "console.log(123)"',test:'node -e "console.log(456)"'}}));
    const commands = [['node',['--version']],['git',['--version']],['dotnet',['--version']],['pwsh',['--version']],['powershell',['-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()']],['npm',['--version']],['npm',['run','check']],['npm',['test']]];
    const npmShim = join(dirname(process.execPath),'npm.cmd');
    if (existsSync(npmShim)) commands.push([npmShim,['run','check']]);
    for (const [command,args] of commands) {
      const a = await seed(f,{type:'shell',command,args},`CLI ${command} ${args[0]}`);
      await expect(approve(f,a,false)).rejects.toThrow(/MANUAL/);
      if (command === 'node') {
        const ui = await card(f,a);
        await expect(ui).toContainText('OS 샌드박스');
        await f.page.getByRole('button',{name:'Switch to English',exact:true}).click();
        await expect(ui).toContainText('no OS sandbox');
        await f.page.getByRole('button',{name:'한국어로 전환',exact:true}).click();
        await ui.getByRole('checkbox').check();
        await ui.getByRole('button',{name:'승인 후 실행',exact:true}).click();
        await waitExecution(f,a);
      } else await approve(f,a);
      const stdout = await waitExecution(f,a);
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
    const argv = ['한글 공백','"quote"','& echo unsafe','%PATH%','!x!'];
    const a = await seed(f,{type:'shell',command:'node',args:['-e','console.log(JSON.stringify(process.argv.slice(1)))',...argv]},'인수 검수');
    await approve(f,a);
    expect(JSON.parse(await waitExecution(f,a))).toEqual(argv);
    const cancel = await seed(f,{type:'shell',command:'node',args:['-e',"require('node:fs').writeFileSync('started.txt','started');setTimeout(()=>require('node:fs').writeFileSync('late.txt','unexpected'),1200)"]},'명령 취소 검수');
    await approve(f,cancel);
    await expect.poll(()=>existsSync(join(f.target,'started.txt'))).toBe(true);
    await f.page.evaluate(taskRunId=>window.harness.runner.cancelExecution({taskRunId}),cancel.taskRunId);
    await expect.poll(async () => (await f.page.evaluate(taskRunId=>window.harness.conversation.getTaskRunDetail({taskRunId}),cancel.taskRunId)).taskRun.status).toBe('cancelled');
    // A bounded wait past the fixture's scheduled side effect verifies real process termination.
    await new Promise(resolve=>setTimeout(resolve,1300));
    expect(existsSync(join(f.target,'late.txt'))).toBe(false);
  } finally { await f.close(); }
});

test('real Electron Recycle Bin deletion requires inspected file metadata and leaves audit evidence', async () => {
  const f = await launch();
  try {
    writeFileSync(join(f.target,'삭제 검수.txt'),'disposable acceptance fixture');
    const a = await seed(f,{type:'file_delete',fileDelete:{path:'삭제 검수.txt'}},'삭제 검수');
    await expect(approve(f,a)).rejects.toThrow();
    const ui = await card(f,a);
    await ui.getByRole('button',{name:'세부 수정',exact:true}).click();
    await f.page.getByRole('dialog').getByRole('button',{name:'저장',exact:true}).click();
    await expect(ui).toContainText('sha256');
    await ui.getByRole('checkbox').check();
    await ui.getByRole('button',{name:'승인 후 실행',exact:true}).click();
    await waitExecution(f,a);

    await expect.poll(()=>existsSync(join(f.target,'삭제 검수.txt'))).toBe(false);
    // OS trash can finish before the runner persists its completion evidence.
    await expect.poll(async () => {
      const fresh = await f.page.evaluate(id=>window.harness.conversation.getTaskRunDetail({taskRunId:id}),a.taskRunId);
      return fresh.approvals.find(row=>row.id===a.id).status;
    }).toBe('executed');
    const detail = await f.page.evaluate(id=>window.harness.conversation.getTaskRunDetail({taskRunId:id}),a.taskRunId);
    expect(detail.approvals.find(row=>row.id===a.id).status).toBe('executed');
    expect(detail.artifacts.some(row=>row.kind==='diff' && row.title.includes('deleted'))).toBe(true);
    await f.page.reload();
    await expect(execute(f,a)).rejects.toThrow();
  } finally { await f.close(); }
});

test('abandoned execution claims survive restart as uncertain and are never replayed', async () => {
  const f = await launch();
  let restarted;
  try {
    const a = await seed(f,{type:'file_write',filePatch:{path:'no-replay.txt',after:'no'}},'재시작 검수');
    await f.app.evaluate(({app},id) => {
      const path = process.getBuiltinModule('node:path');
      const load = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
      const db = new (load('better-sqlite3'))(path.join(app.getPath('userData'),'app.db'));
      try { db.prepare("UPDATE approvals SET status='approved',approved_revision=action_revision,execution_state='running',execution_token='abandoned',execution_started_at=? WHERE id=?").run(new Date().toISOString(),id); }
      finally { db.close(); }
    }, a.id);
    await f.app.close();
    const userData = join(f.dir,'userData');
    const env = {...process.env,HARNESS_E2E_USER_DATA:userData,HARNESS_E2E_FAKE_AGENT:'1'};
    delete env.ELECTRON_RUN_AS_NODE;
    restarted = await electron.launch({args:['--no-sandbox',...(executablePath ? [] : [main]),`--user-data-dir=${userData}`],env,
      ...(executablePath ? { executablePath } : {})});
    const page = await restarted.firstWindow();
    await expect(page.getByRole('button',{name:'새 작업',exact:true})).toBeVisible();
    const detail = await page.evaluate(id=>window.harness.conversation.getTaskRunDetail({taskRunId:id}),a.taskRunId);
    expect(detail.approvals.find(row=>row.id===a.id).executionState).toBe('uncertain');
    await expect(page.evaluate(id=>window.harness.runner.executeApproved({approvalId:id}),a.id)).rejects.toThrow(/CLAIM/);
    expect(existsSync(join(f.target,'no-replay.txt'))).toBe(false);
    expect(detail.agentInvocations).toHaveLength(0);
  } finally {
    if (restarted) await restarted.close();
    else await f.app.close();
    rmSync(f.dir,{recursive:true,force:true});
  }
});
