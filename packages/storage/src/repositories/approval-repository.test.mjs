import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteApprovalRepository } from "./approval-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-apv-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedCheckpoint = (db) => {
  db.prepare(
    `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
     VALUES('thr_1', 'Thread', '/tmp/project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
     VALUES('tsk_1', 'thr_1', 'Do it', '/tmp/project', 'drafting', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO steps(id, task_run_id, step_index, kind, title, status)
     VALUES('stp_1', 'tsk_1', 0, 'approval', 'Approval', 'pending')`,
  ).run();
  db.prepare(
    `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
     VALUES('ckp_1', 'tsk_1', 'stp_1', 'before_edit', '{}', 'checkpoint', '2026-01-01T00:00:00.000Z')`,
  ).run();
};

const seedDecisionLogFixture = (db) => {
  for (const row of [
    ["thr_log_1", "Primary thread"],
    ["thr_log_2", "Secondary thread"],
  ]) {
    db.prepare(
      `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
       VALUES(?, ?, '/tmp/project', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
    ).run(...row);
  }
  for (const row of [
    ["tsk_log_1", "thr_log_1", "Write guarded file", "waiting_for_approval"],
    ["tsk_log_2", "thr_log_1", "Run safe shell", "running"],
    ["tsk_log_3", "thr_log_2", "Use model", "done"],
  ]) {
    db.prepare(
      `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
       VALUES(?, ?, ?, '/tmp/project', ?, NULL, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
    ).run(...row);
  }
  for (const row of [
    ["stp_log_1", "tsk_log_1"],
    ["stp_log_2", "tsk_log_2"],
    ["stp_log_3", "tsk_log_3"],
  ]) {
    db.prepare(
      `INSERT INTO steps(id, task_run_id, step_index, kind, title, status)
       VALUES(?, ?, 0, 'approval', 'Approval', 'pending')`,
    ).run(...row);
  }
  for (const row of [
    ["ckp_log_1", "tsk_log_1", "stp_log_1"],
    ["ckp_log_2", "tsk_log_2", "stp_log_2"],
    ["ckp_log_3", "tsk_log_3", "stp_log_3"],
  ]) {
    db.prepare(
      `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
       VALUES(?, ?, ?, 'before_edit', '{}', 'checkpoint', '2026-05-01T00:00:00.000Z')`,
    ).run(...row);
  }
  const insertApproval = db.prepare(
    `INSERT INTO approvals(
       id, task_run_id, checkpoint_id, action_type, action_summary, status,
       decision_message, decided_at, auto_approve_decision_json
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertApproval.run(
    "apv_log_blocked",
    "tsk_log_1",
    "ckp_log_1",
    "file_write",
    "Write guarded file",
    "rejected",
    "auto blocked",
    "2026-05-03T10:00:00.000Z",
    JSON.stringify({
      approved: false,
      decidedAt: "budget_blocked",
      reason: "Daily budget exceeded",
    }),
  );
  insertApproval.run(
    "apv_log_shell",
    "tsk_log_2",
    "ckp_log_2",
    "shell",
    "Run safe shell",
    "approved",
    "auto approved",
    "2026-05-02T10:00:00.000Z",
    JSON.stringify({
      approved: true,
      decidedAt: "global_toggle",
      reason: "Global auto-approve enabled",
    }),
  );
  insertApproval.run(
    "apv_log_model",
    "tsk_log_3",
    "ckp_log_3",
    "model_use",
    "Use recommended model",
    "approved",
    "auto approved",
    "2026-05-01T10:00:00.000Z",
    JSON.stringify({
      approved: true,
      decidedAt: "profile_auto_approve",
      reason: "Profile allows this action",
    }),
  );
  insertApproval.run(
    "apv_log_manual",
    "tsk_log_3",
    "ckp_log_3",
    "file_write",
    "Manual approval",
    "approved",
    "manual",
    "2026-05-04T10:00:00.000Z",
    null,
  );
};

test("ApprovalRepository round-trips policyEvaluation", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedCheckpoint(db);
    const repo = new SqliteApprovalRepository(db);
    const created = await repo.create({
      taskRunId: "tsk_1",
      checkpointId: "ckp_1",
      actionType: "network",
      actionSummary: "Network call",
      policyEvaluation: {
        operation: { kind: "approval_action", actionType: "network" },
        decision: "confirm",
        riskLevel: "high",
        allowAutoApprove: false,
        reason: "Network requires manual confirmation",
      },
    });
    assert.equal(created.policyEvaluation?.allowAutoApprove, false);

    const fetched = await repo.get(created.id);
    assert.deepEqual(fetched?.policyEvaluation, created.policyEvaluation);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ApprovalRepository persists auto-approve decision trace on automatic approvals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedCheckpoint(db);
    const repo = new SqliteApprovalRepository(db);
    const created = await repo.create({
      taskRunId: "tsk_1",
      checkpointId: "ckp_1",
      actionType: "file_write",
      actionSummary: "Write file",
    });
    const decision = {
      approved: true,
      decidedAt: "global_toggle",
      reason: "Global auto-approve is enabled.",
    };

    const approved = await repo.decide(created.id, "approved", "auto", {
      autoApproveDecision: decision,
    });
    assert.deepEqual(approved.autoApproveDecision, decision);

    const fetched = await repo.get(created.id);
    assert.deepEqual(fetched?.autoApproveDecision, decision);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ApprovalRepository leaves manual approvals with null auto-approve decision", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedCheckpoint(db);
    const repo = new SqliteApprovalRepository(db);
    const created = await repo.create({
      taskRunId: "tsk_1",
      checkpointId: "ckp_1",
      actionType: "file_write",
      actionSummary: "Write file",
    });

    const approved = await repo.decide(created.id, "approved", "manual");
    assert.equal(approved.autoApproveDecision, null);

    const fetched = await repo.get(created.id);
    assert.equal(fetched?.autoApproveDecision, null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ApprovalRepository decision log ignores manual rows and paginates newest first", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedDecisionLogFixture(db);
    const repo = new SqliteApprovalRepository(db);

    const page = await repo.listAllWithDecisionTrace({
      limit: 2,
      offset: 0,
    });

    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
    assert.equal(page.hasNext, true);
    assert.deepEqual(
      page.items.map((item) => item.approval.id),
      ["apv_log_blocked", "apv_log_shell"],
    );
    assert.equal(page.items[0].threadTitle, "Primary thread");
    assert.equal(page.items[0].taskRunUserRequest, "Write guarded file");
    assert.equal(page.items[0].approval.autoApproveDecision.reason, "Daily budget exceeded");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("ApprovalRepository decision log filters by step, action type, and date", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedDecisionLogFixture(db);
    const repo = new SqliteApprovalRepository(db);

    const page = await repo.listAllWithDecisionTrace({
      limit: 50,
      offset: 0,
      filter: {
        decidedAtSteps: ["budget_blocked"],
        actionTypes: ["file_write"],
        sinceIso: "2026-05-03T00:00:00.000Z",
        untilIso: "2026-05-04T00:00:00.000Z",
      },
    });

    assert.equal(page.total, 1);
    assert.equal(page.hasNext, false);
    assert.equal(page.items[0].approval.id, "apv_log_blocked");
    assert.equal(page.items[0].approval.autoApproveDecision.approved, false);
    assert.equal(page.items[0].approval.autoApproveDecision.decidedAt, "budget_blocked");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
