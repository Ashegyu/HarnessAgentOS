import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { applyMigrations } from "./migrations.ts";

export type HarnessDb = DatabaseType;

export interface OpenDbOptions {
  /** Absolute path to the SQLite file (e.g. `app.db`). */
  filePath: string;
  /** When true, opens the DB read-only. Default false. */
  readonly?: boolean;
}

/**
 * Open the canonical SQLite WAL database used by HarnessAgentOS.
 *
 * Pragmas enforced (see docs/implementation/phase-01-local-state-model.md
 * 데이터 흐름 - "App boot"):
 *   PRAGMA journal_mode=WAL
 *   PRAGMA foreign_keys=ON
 *   PRAGMA busy_timeout=5000
 *
 * Migrations are applied idempotently on writable opens. Read-only opens are
 * query-only and require an already migrated database.
 */
export const openDb = (options: OpenDbOptions): HarnessDb => {
  const readonly = options.readonly ?? false;
  const db = new Database(options.filePath, {
    readonly,
  });

  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (readonly) {
      db.pragma("query_only = ON");
      return db;
    }

    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    return db;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
};

export const closeDb = (db: HarnessDb): void => {
  if (db.open) db.close();
};
