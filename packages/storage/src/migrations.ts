import type { Database as DatabaseType } from "better-sqlite3";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

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

export const readSchemaVersion = (db: DatabaseType): number | null => {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  const v = Number.parseInt(row.value, 10);
  return Number.isFinite(v) ? v : null;
};
