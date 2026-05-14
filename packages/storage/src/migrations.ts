import type { Database as DatabaseType } from "better-sqlite3";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.ts";

/**
 * Idempotent migration runner. Phase 1 ships schema v1 covering all
 * 9 tables defined in docs/architecture/harness-agent-os-design.md §14.
 * Subsequent phases append column-add steps below; each is a no-op if
 * the column already exists, so applying migrations multiple times
 * leaves the DB in the same state.
 */
export const applyMigrations = (db: DatabaseType): void => {
  const txn = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt);
    }

    // Phase 3 — proposed_action_json on approvals.
    if (!hasColumn(db, "approvals", "proposed_action_json")) {
      db.exec(`ALTER TABLE approvals ADD COLUMN proposed_action_json TEXT`);
    }

    // v5 — agent_session_id on threads. Stores the Claude CLI session
    // UUID so subsequent TaskRuns in the same thread can `--resume` the
    // conversation instead of starting cold.
    if (!hasColumn(db, "threads", "agent_session_id")) {
      db.exec(`ALTER TABLE threads ADD COLUMN agent_session_id TEXT`);
    }

    // v12 — pipeline_id on threads. When set, every TaskRun in the
    // thread routes through orchestration.draftPlan with this pipeline
    // instead of the regular single-profile chat path. NULL means
    // "regular chat". Deliberately no FK — pipeline deletion is
    // tolerated; UI falls back to regular chat in that case. See
    // docs/design/pipeline-thread-binding-plan.html §4.2.
    if (!hasColumn(db, "threads", "pipeline_id")) {
      db.exec(`ALTER TABLE threads ADD COLUMN pipeline_id TEXT`);
    }

    // v6 — expand approvals.status CHECK to include 'executed'.
    // SQLite doesn't support ALTER CONSTRAINT; the table must be rebuilt.
    if (!approvalStatusAllows(db, "executed")) {
      db.exec(`ALTER TABLE approvals RENAME TO approvals_v5`);
      db.exec(`CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('file_write','shell','dependency_install','git_commit','network','skill_script','orchestration_plan')),
        action_summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run','executed')),
        decision_message TEXT,
        decided_at TEXT,
        proposed_action_json TEXT,
        FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
        FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
      )`);
      db.exec(`INSERT INTO approvals SELECT id,task_run_id,checkpoint_id,action_type,action_summary,status,decision_message,decided_at,proposed_action_json FROM approvals_v5`);
      db.exec(`DROP TABLE approvals_v5`);
    }

    db.prepare(
      `INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)`,
    ).run(String(SCHEMA_VERSION));
  });
  txn();
};

const hasColumn = (
  db: DatabaseType,
  table: string,
  column: string,
): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
};

const approvalStatusAllows = (db: DatabaseType, status: string): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'`)
    .get() as { sql: string } | undefined;
  return row?.sql?.includes(`'${status}'`) ?? false;
};

export const readSchemaVersion = (db: DatabaseType): number | null => {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  const v = Number.parseInt(row.value, 10);
  return Number.isFinite(v) ? v : null;
};
