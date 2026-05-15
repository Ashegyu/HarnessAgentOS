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
