import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "./local-state-service.ts";
import { ConversationService } from "../../../core/src/conversation/conversation-service.ts";
import { TaskRunCompletionService } from "../../../core/src/task-run/task-run-completion-service.ts";
import { applyMigrations } from "../migrations.ts";
import { SCHEMA_VERSION } from "../schema.ts";
import { RunnerService } from "../../../runners/src/runner-service.ts";
import { FilesystemArtifactStore } from "../index.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function fixture(t, executionState) {
  const root = mkdtempSync(join(tmpdir(), "approval-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ filePath: ":memory:" });
  t.after(() => closeDb(db));
  const state = new LocalStateService(db);
  const conversation = new ConversationService({ state, pathExists: () => true });
  const draft = await conversation.createTask({ targetDir: root, userRequest: "파일을 수정해줘", mode: "template" });
  const source = draft.approvals[0];
  await conversation.setProposedAction(source.id, { type: "file_write", filePatch: { path: "retry.txt", before: "old", after: "new" } });
  await conversation.approve({ approvalId: source.id });
  if (executionState) {
    await state.claimApprovalExecution(source.id, 2, "old-owner");
    await state.finishApprovalExecution(source.id, "old-owner", executionState);
    if (executionState === "succeeded") await state.decideApproval(source.id, "executed");
  }
  await state.setTaskRunStatus(draft.taskRun.id, executionState === "succeeded" ? "quality_failed" : "blocked");
  const current = await state.getApproval(source.id);
  return { root, db, state, conversation, draft, source: current, input: {
    approvalId: current.id, expectedRevision: current.actionRevision,
    expectedExecutionState: current.executionState ?? null, reviewMessage: "이전 실행 결과와 파일 상태를 확인함",
  } };
}

for (const executionState of [undefined, "uncertain", "succeeded"]) {
  test(`review creates a fresh manual pending approval for ${executionState ?? "pre-execution failure"}`, async t => {
    const f = await fixture(t, executionState);
    const next = await f.conversation.prepareActionRetry(f.input);
    assert.notEqual(next.id, f.source.id);
    assert.equal(next.status, "pending");
    assert.equal(next.requiresManualApproval, true);
    assert.equal(next.executionState, undefined);
    assert.equal(next.approvedRevision, undefined);
    assert.deepEqual(next.proposedAction, f.source.proposedAction);
    const old = await f.state.getApproval(f.source.id);
    assert.equal(old.retryApprovalId, next.id);
    assert.equal(old.executionState, executionState);
    assert.equal(old.status, f.source.status);
    assert.equal(old.actionRevision, f.source.actionRevision);
    assert.equal((await f.state.getTaskRun(f.draft.taskRun.id)).status, "waiting_for_approval");
    await assert.rejects(f.conversation.approve({ approvalId: next.id }), /MANUAL_REQUIRED/);
    await assert.rejects(f.state.claimApprovalExecution(next.id, 1, "new-owner"), /CLAIM_LOCKED/);
  });
}

test("duplicate review is idempotent and stale or unreviewed requests do not create work", async t => {
  const f = await fixture(t, "uncertain");
  await assert.rejects(f.conversation.prepareActionRetry({ ...f.input, reviewMessage: " " }), /review|검토/i);
  await assert.rejects(f.conversation.prepareActionRetry({ ...f.input, expectedRevision: 99 }), /REVISION/);
  await assert.rejects(f.conversation.prepareActionRetry({ ...f.input, expectedExecutionState: null }), /changed|변경/i);
  const [a, b] = await Promise.all([f.conversation.prepareActionRetry(f.input), f.conversation.prepareActionRetry(f.input)]);
  assert.equal(a.id, b.id);
  assert.equal((await f.state.listApprovalsByTaskRun(f.draft.taskRun.id)).length, 2);
});

test("a reviewed unclaimed source cannot be claimed or edited after replacement", async t => {
  const f = await fixture(t);
  await f.conversation.prepareActionRetry(f.input);
  await assert.rejects(f.state.claimApprovalExecution(f.source.id, f.source.actionRevision, "late-owner"), /CLAIM_LOCKED/);
  await assert.rejects(f.state.setApprovalProposedAction(f.source.id, f.source.proposedAction), /LOCKED/);
});

test("review rejects a running owner and a terminal task", async t => {
  const f = await fixture(t);
  await f.state.claimApprovalExecution(f.source.id, f.source.actionRevision, "running");
  await assert.rejects(f.conversation.prepareActionRetry({ ...f.input, expectedExecutionState: "running" }), /running|실행 중/i);
  await f.state.finishApprovalExecution(f.source.id, "running", "uncertain");
  await f.state.setTaskRunStatus(f.draft.taskRun.id, "cancelled");
  await assert.rejects(f.conversation.prepareActionRetry({ ...f.input, expectedExecutionState: "uncertain" }), /state|상태/i);
});

test("a manually approved replacement executes once and resolves the reviewed uncertain attempt", async t => {
  const f = await fixture(t, "uncertain");
  const next = await f.conversation.prepareActionRetry(f.input);
  await f.conversation.setProposedAction(next.id, { type: "file_write", filePatch: { path: "retry.txt", after: "reviewed" } });
  const configured = await f.state.getApproval(next.id);
  await f.conversation.approve({ approvalId: next.id, expectedRevision: configured.actionRevision, manualConfirmation: true });
  const runner = new RunnerService({ state: f.state, artifactStore: new FilesystemArtifactStore({ rootDir: join(f.root, "artifacts") }) });
  await runner.executeApproved(next.id);
  assert.equal(readFileSync(join(f.root, "retry.txt"), "utf8"), "reviewed");
  assert.equal((await f.state.getTaskRun(f.draft.taskRun.id)).status, "ready_for_review");
  await assert.rejects(runner.executeApproved(next.id));
  assert.equal((await f.state.getApproval(f.source.id)).executionState, "uncertain");
});

test("partial persistence failure rolls back the replacement, source link and task status", async t => {
  const f = await fixture(t, "uncertain");
  const before = f.db.prepare("SELECT (SELECT COUNT(*) FROM approvals) a, (SELECT COUNT(*) FROM checkpoints) c, (SELECT COUNT(*) FROM steps) s").get();
  f.db.exec("CREATE TRIGGER reject_retry_report BEFORE INSERT ON artifacts WHEN NEW.title='이전 실행 결과 검토' BEGIN SELECT RAISE(ABORT,'injected review failure'); END;");
  await assert.rejects(f.conversation.prepareActionRetry(f.input), /injected review failure/);
  assert.deepEqual(f.db.prepare("SELECT (SELECT COUNT(*) FROM approvals) a, (SELECT COUNT(*) FROM checkpoints) c, (SELECT COUNT(*) FROM steps) s").get(), before);
  assert.equal((await f.state.getApproval(f.source.id)).retryApprovalId, undefined);
  assert.equal((await f.state.getTaskRun(f.draft.taskRun.id)).status, "blocked");
});

test("unsupported and read-only actions do not acquire a replacement", async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE approvals SET action_type='model_use' WHERE id=?").run(f.source.id);
  await assert.rejects(f.conversation.prepareActionRetry(f.input), /대상이 아닙니다/);
  f.db.prepare("UPDATE approvals SET action_type='file_write' WHERE id=?").run(f.source.id);
  const { buildTaskContract } = await import("@harness/core");
  f.db.prepare("UPDATE task_contracts SET contract_json=? WHERE task_run_id=?").run(JSON.stringify(buildTaskContract({ userRequest: "설명해줘", intent: "answer" })), f.draft.taskRun.id);
  await assert.rejects(f.conversation.prepareActionRetry(f.input), /대상이 아닙니다/);
  assert.equal((await f.state.listApprovalsByTaskRun(f.draft.taskRun.id)).length, 1);
});

test("two connections reserve the same durable replacement and preserve it after reopen", async t => {
  const f = await fixture(t, "uncertain");
  const file = join(f.root, "recovery.db"); await f.db.backup(file);
  const a = openDb({ filePath: file }), b = openDb({ filePath: file });
  let id;
  try {
    const first = new LocalStateService(a), second = new LocalStateService(b);
    const [left, right] = await Promise.all([first.prepareApprovalRetry(f.input), second.prepareApprovalRetry(f.input)]);
    assert.equal(left.id, right.id); id = left.id;
    assert.equal((await second.listApprovalsByTaskRun(f.draft.taskRun.id)).length, 2);
    await assert.rejects(second.claimApprovalExecution(f.source.id, f.source.actionRevision, "old"), /CLAIM_LOCKED/);
  } finally { closeDb(a); closeDb(b); }
  const reopened = openDb({ filePath: file });
  try {
    const state = new LocalStateService(reopened);
    assert.equal((await state.getApproval(f.source.id)).retryApprovalId, id);
    assert.equal((await state.getApproval(id)).requiresManualApproval, true);
    await state.deleteThread(f.draft.taskRun.threadId);
    assert.equal(await state.getApproval(id), null);
  } finally { closeDb(reopened); }
});

test("review does not settle a task until the new approval is resolved", async t => {
  const f = await fixture(t, "uncertain");
  const next = await f.conversation.prepareActionRetry(f.input);
  // A gate fixture isolates approval settlement from checker provenance.
  await f.state.createQualityGateResult({ id: "review-gate", taskRunId: f.draft.taskRun.id, status: "passed",
    knownRisks: [], evidenceArtifactIds: [], createdAt: new Date().toISOString() });
  await f.state.setTaskRunStatus(f.draft.taskRun.id, "ready_for_review");
  const completion = new TaskRunCompletionService({ state: f.state });
  await assert.rejects(completion.markDone({ taskRunId: f.draft.taskRun.id }), /승인|execution|settled/i);
  await assert.rejects(f.state.completeTaskRun(f.draft.taskRun.id, "review-gate"), /settled/);
  await f.conversation.approve({ approvalId: next.id, manualConfirmation: true });
  await f.state.claimApprovalExecution(next.id, 1, "new-owner");
  await f.state.finishApprovalExecution(next.id, "new-owner", "succeeded");
  await f.state.decideApproval(next.id, "executed");
  assert.equal((await completion.markDone({ taskRunId: f.draft.taskRun.id })).status, "done");
  assert.equal((await f.state.getApproval(f.source.id)).executionState, "uncertain");
});

test("v41 upgrade adds an empty review link without rewriting prior consent", async t => {
  const f = await fixture(t, "uncertain");
  f.db.exec("ALTER TABLE approvals DROP COLUMN retry_approval_id; UPDATE schema_meta SET value='41' WHERE key='schema_version';");
  applyMigrations(f.db); applyMigrations(f.db);
  assert.equal((await f.state.getApproval(f.source.id)).executionState, "uncertain");
  assert.equal((await f.state.getApproval(f.source.id)).retryApprovalId, undefined);
    assert.equal(f.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
});

test("a late approval decision cannot mutate consent retired during its await", async t => {
  const f = await fixture(t);
  const originalGet = f.state.approvals.get.bind(f.state.approvals);
  let release, captured;
  const waiting = new Promise(resolve => { captured = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.state.approvals.get = async id => {
    const row = await originalGet(id);
    if (id === f.source.id) { captured(); await gate; }
    return row;
  };
  const staleDecision = f.state.decideApproval(f.source.id, "rejected", "late decision");
  await waiting;
  await f.conversation.prepareActionRetry(f.input);
  release();
  await assert.rejects(staleDecision, /LOCKED/);
  assert.equal((await originalGet(f.source.id)).status, "approved");
});
