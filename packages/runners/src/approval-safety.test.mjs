import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, LocalStateService, FilesystemArtifactStore } from '@harness/storage';
import { ConversationService, shouldAutoApprove } from '@harness/core';
import { RunnerService } from './runner-service.ts';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hgos-approval-safety-'));
  const target = join(dir, 'target');
  mkdirSync(target);
  const db = openDb({ filePath: join(dir, 'test.db') });
  t.after(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });
  const state = new LocalStateService(db);
  const conversation = new ConversationService({ state, pathExists: async () => true });
  db.prepare(`INSERT INTO threads(id,title,target_dir,created_at,updated_at) VALUES ('thr', 'Safety', ?, '2026-09-07', '2026-09-07')`).run(target);
  db.prepare(`INSERT INTO task_runs(id,thread_id,user_request,target_dir,status,created_at,updated_at) VALUES ('tsk','thr','edit',?,'waiting_for_approval','2026-09-07','2026-09-07')`).run(target);
  db.exec(`INSERT INTO steps(id,task_run_id,step_index,kind,title,status) VALUES ('step','tsk',0,'approval','Approve','pending');
    INSERT INTO checkpoints(id,task_run_id,step_id,reason,state_ref,summary,created_at) VALUES ('cp','tsk','step','before_edit','{}','Safety','2026-09-07')`);
  const approval = await state.createApproval({ taskRunId: 'tsk', checkpointId: 'cp', actionType: 'file_write', actionSummary: 'A', proposedAction: { type: 'file_write', filePatch: { path: 'A.txt', after: 'A' } } });
  const artifactStore = new FilesystemArtifactStore({ rootDir: join(dir, 'artifacts') });
  return { dir, target, db, state, conversation, approval, artifactStore };
}

test('changing an approved action invalidates consent and rejects a stale approval revision', async t => {
  const f = await fixture(t);
  await f.conversation.approve({ approvalId: f.approval.id, expectedRevision: 1 });
  const changed = await f.conversation.setProposedAction(f.approval.id, { type: 'file_write', filePatch: { path: 'B.txt', after: 'B' } });
  assert.equal(changed.status, 'pending');
  assert.equal(changed.actionRevision, 2);
  assert.equal(changed.requiresManualApproval, true);
  await assert.rejects(f.conversation.approve({ approvalId: changed.id, expectedRevision: 1 }), /REVISION/);
  await assert.rejects(new RunnerService(f).executeApproved(changed.id), /approved/);
  await assert.rejects(f.conversation.approve({ approvalId: changed.id, expectedRevision: 2, autoApproveDecision: { approved: true, decidedAt: 'global_toggle', reason: 'auto' } }), /MANUAL/);
  await f.conversation.approve({ approvalId: changed.id, expectedRevision: 2, manualConfirmation: true });
  await new RunnerService(f).executeApproved(changed.id);
  assert.equal(readFileSync(join(f.target, 'B.txt'), 'utf8'), 'B');
  const events = f.db.prepare('SELECT status,action_revision,proposed_action_json FROM approval_events WHERE approval_id=? ORDER BY id').all(changed.id);
  assert.ok(events.some(row => row.status === 'approved' && row.action_revision === 1 && row.proposed_action_json.includes('A.txt')));
  assert.ok(events.some(row => row.status === 'approved' && row.action_revision === 2 && row.proposed_action_json.includes('B.txt')));
});

test('20 concurrent executions across independent runner instances perform exactly one effect', async t => {
  const f = await fixture(t);
  await f.conversation.approve({ approvalId: f.approval.id, expectedRevision: 1 });
  let calls = 0;
  const fileRunner = { run: async () => {
    calls++;
    appendFileSync(join(f.target, 'effects.txt'), 'x');
    await new Promise(r => setTimeout(r, 25));
    return { path: join(f.target, 'A.txt'), bytesWritten: 1, afterContent: 'A', beforeContent: null };
  } };
  const secondDb = openDb({filePath:join(f.dir,'test.db')});
  try {
    const secondState = new LocalStateService(secondDb);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_,index) => new RunnerService({ ...f, state:index % 2 ? secondState : f.state, fileRunner }).executeApproved(f.approval.id)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  } finally { closeDb(secondDb); }
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(f.target, 'effects.txt'), 'utf8'), 'x');
});

test('claimed and uncertain executions cannot be edited, reapproved, or replayed', async t => {
  const f = await fixture(t);
  await f.conversation.approve({ approvalId: f.approval.id, expectedRevision: 1 });
  await f.state.claimApprovalExecution(f.approval.id, 1, 'owner');
  await assert.rejects(f.conversation.setProposedAction(f.approval.id, f.approval.proposedAction), /LOCKED/);
  await assert.rejects(f.conversation.approve({ approvalId: f.approval.id, expectedRevision: 1 }), /LOCKED|TRANSITION/);
  await f.state.finishApprovalExecution(f.approval.id, 'owner', 'uncertain');
  await assert.rejects(new RunnerService(f).executeApproved(f.approval.id), /CLAIM|LOCKED/);
  assert.equal((await f.state.getApproval(f.approval.id)).executionState, 'uncertain');
});

test('rejected and cancelled-task approvals cannot be resurrected', async t => {
  const f = await fixture(t);
  await f.conversation.rejectApproval({ approvalId: f.approval.id, message: 'No' });
  await assert.rejects(f.conversation.approve({ approvalId: f.approval.id, expectedRevision: 1 }), /TRANSITION/);
  f.db.prepare("UPDATE task_runs SET status='cancelled' WHERE id='tsk'").run();
  await assert.rejects(f.conversation.setProposedAction(f.approval.id, f.approval.proposedAction), /LOCKED|TERMINAL/);
});

test('host shell and changed actions cannot use global or profile auto consent', () => {
  for (const approval of [{ actionType: 'shell' }, { actionType: 'file_delete' }, { actionType: 'file_write', requiresManualApproval: true }]) {
    assert.equal(shouldAutoApprove({ approval, globalAutoApprove: true, activeProfile: { permissions: { autoApproveActions: ['shell', 'file_write'], blockedActions: [] } } }).approved, false);
  }
});

test('different approvals remain parallel while each approval is single consumption', async t => {
  const f = await fixture(t);
  const other = await f.state.createApproval({ taskRunId:'tsk',checkpointId:'cp',actionType:'file_write',actionSummary:'other',proposedAction:{type:'file_write',filePatch:{path:'other.txt',after:'other'}} });
  for (const approval of [f.approval, other]) await f.conversation.approve({approvalId:approval.id,expectedRevision:1});
  let running = 0;
  let maximum = 0;
  const fileRunner = { run: async ({ patch }) => {
    maximum = Math.max(maximum, ++running);
    await new Promise(resolve => setTimeout(resolve, 30));
    running--;
    return {path:patch.path,afterContent:patch.after,bytesWritten:1,beforeContent:null};
  }};
  await Promise.all([f.approval, other].map(approval => new RunnerService({...f,fileRunner}).executeApproved(approval.id)));
  assert.equal(maximum, 2);
});
