import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { applyMigrations } from "./migrations";

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
 * Migrations are applied idempotently on every open.
 */
export const openDb = (options: OpenDbOptions): HarnessDb => {
  const db = new Database(options.filePath, {
    readonly: options.readonly ?? false,
  });

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  applyMigrations(db);

  return db;
};

export const closeDb = (db: HarnessDb): void => {
  if (db.open) db.close();
};
