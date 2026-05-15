import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "./db.ts";
import { applyMigrations, readSchemaVersion } from "./migrations.ts";
import { SCHEMA_VERSION } from "./schema.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-schema-"));
  return { dir, file: join(dir, "test.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("opening a fresh DB applies pragmas and creates all tables", () => {
  const t = tmp();
  try {
    const db = openDb({ filePath: t.file });
    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("foreign_keys", { simple: true }), 1);

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all()
        .map((r) => r.name);
      for (const expected of [
        "approvals",
        "artifacts",
        "capabilities",
        "checkpoints",
        "evolution_candidates",
        "instincts",
        "learning_traces",
        "observations",
        "quality_gate_results",
        "schema_meta",
        "steps",
        "task_runs",
        "threads",
      ]) {
        assert.ok(tables.includes(expected), `missing table ${expected}`);
      }
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("applyMigrations is idempotent across multiple runs", () => {
  const t = tmp();
  try {
    const db = openDb({ filePath: t.file });
    try {
      applyMigrations(db);
      applyMigrations(db);
      applyMigrations(db);
      assert.equal(readSchemaVersion(db), SCHEMA_VERSION);

      // No duplicate rows in schema_meta despite repeated migration.
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM schema_meta WHERE key='schema_version'`)
        .get();
      assert.equal(count.c, 1);
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});

test("CHECK constraints reject invalid task_run.status", () => {
  const t = tmp();
  try {
    const db = openDb({ filePath: t.file });
    try {
      db.prepare(
        `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
         VALUES(?, ?, NULL, ?, ?)`,
      ).run("thr_x", "t", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      assert.throws(() =>
        db
          .prepare(
            `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            "tsk_x",
            "thr_x",
            "do thing",
            "/tmp/x",
            "BOGUS_STATUS",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
          ),
      );
    } finally {
      closeDb(db);
    }
  } finally {
    t.cleanup();
  }
});
