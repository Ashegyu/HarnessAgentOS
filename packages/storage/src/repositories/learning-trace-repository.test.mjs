import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteLearningTraceRepository } from "./learning-trace-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-lt-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = (db, id) => {
  db.prepare(
    `INSERT OR IGNORE INTO threads(id, title, target_dir, created_at, updated_at)
     VALUES('thr_cost', 'Thread', '/tmp/project', '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
     VALUES(?, 'thr_cost', 'Do it', '/tmp/project', 'done', NULL, '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z')`,
  ).run(id);
};

test("LearningTraceRepository sums cost by TaskRun and ISO day", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedTaskRun(db, "tsk_a");
    seedTaskRun(db, "tsk_b");
    const repo = new SqliteLearningTraceRepository(db);
    const a = await repo.create({ taskRunId: "tsk_a" });
    const b = await repo.create({ taskRunId: "tsk_b" });
    await repo.update(a.id, { costEstimate: 0.4 });
    await repo.update(b.id, { costEstimate: 0.3 });
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T01:00:00.000Z",
      a.id,
    );
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T02:00:00.000Z",
      b.id,
    );

    assert.equal(await repo.sumCostByTaskRun("tsk_a"), 0.4);
    assert.equal(
      await repo.sumCostByDay({ profileId: "ap_profile", isoDate: "2026-05-18" }),
      0.7,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
