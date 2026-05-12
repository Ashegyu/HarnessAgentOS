import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations, readSchemaVersion } from "./migrations.ts";
import { openDb, closeDb } from "./db.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-migr-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const hasTable = (db, name) => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
};

const hasIndex = (db, name) => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
  return row !== undefined;
};

const hasColumn = (db, table, column) => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
};

test("v7 migration creates agent_profiles with the expected columns", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasTable(db, "agent_profiles"), true);
    for (const col of [
      "id",
      "name",
      "description",
      "provider",
      "role",
      "persona",
      "tuning_json",
      "cli_json",
      "permissions_json",
      "mcp_server_ids_json",
      "skill_source_ids_json",
      "is_default",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "agent_profiles", col),
        true,
        `agent_profiles is missing column ${col}`,
      );
    }
    assert.equal(
      hasIndex(db, "idx_agent_profiles_default"),
      true,
      "partial unique index on is_default must exist",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v7 migration enforces a single default profile via partial unique index", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const ins = db.prepare(
      `INSERT INTO agent_profiles
        (id,name,description,provider,role,persona,tuning_json,cli_json,
         permissions_json,mcp_server_ids_json,skill_source_ids_json,
         is_default,created_at,updated_at)
       VALUES (?,?,'','claude','coder','','{}','{}','{}','[]','[]',?,?,?)`,
    );
    ins.run("ap_a", "A", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    // Second default must fail (UNIQUE partial index on is_default=1)
    assert.throws(() =>
      ins.run("ap_b", "B", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    );
    // Two non-default rows must coexist
    ins.run("ap_c", "C", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    ins.run("ap_d", "D", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const count = db.prepare("SELECT COUNT(*) AS c FROM agent_profiles").get().c;
    assert.equal(count, 3);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v7 migration rejects unknown provider/role via CHECK constraints", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const ins = db.prepare(
      `INSERT INTO agent_profiles
        (id,name,description,provider,role,persona,tuning_json,cli_json,
         permissions_json,mcp_server_ids_json,skill_source_ids_json,
         is_default,created_at,updated_at)
       VALUES (?,?,'',?,?,'','{}','{}','{}','[]','[]',0,?,?)`,
    );
    assert.throws(() =>
      ins.run(
        "ap_x",
        "X",
        "openai",
        "coder",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
    assert.throws(() =>
      ins.run(
        "ap_y",
        "Y",
        "claude",
        "destroyer",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v8 migration creates mcp_servers with transport + scope CHECK", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasTable(db, "mcp_servers"), true);
    for (const col of [
      "id",
      "name",
      "description",
      "transport",
      "command",
      "args_json",
      "url",
      "env_json",
      "env_secret_refs_json",
      "scope",
      "enabled",
      "last_health_json",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "mcp_servers", col),
        true,
        `mcp_servers is missing column ${col}`,
      );
    }
    const ins = db.prepare(
      `INSERT INTO mcp_servers
        (id,name,description,transport,command,args_json,url,
         env_json,env_secret_refs_json,scope,enabled,
         last_health_json,created_at,updated_at)
       VALUES (?,?,'',?,?,'[]',?, '{}','{}',?,1,NULL,?,?)`,
    );
    assert.throws(() =>
      ins.run(
        "mcp_bad",
        "B",
        "websocket",
        null,
        null,
        "global",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
    assert.throws(() =>
      ins.run(
        "mcp_bad2",
        "B",
        "stdio",
        "/bin/x",
        null,
        "everywhere",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v9 migration creates skill_sources with UNIQUE root_dir", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasTable(db, "skill_sources"), true);
    for (const col of [
      "id",
      "name",
      "origin",
      "root_dir",
      "trusted",
      "enabled",
      "registered_in_path_policy",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "skill_sources", col),
        true,
        `skill_sources is missing column ${col}`,
      );
    }
    const ins = db.prepare(
      `INSERT INTO skill_sources
        (id,name,origin,root_dir,trusted,enabled,registered_in_path_policy,
         created_at,updated_at)
       VALUES (?,?,?,?,0,1,0,?,?)`,
    );
    ins.run("ss_a", "A", "custom", "/tmp/skills", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    assert.throws(() =>
      ins.run(
        "ss_b",
        "B",
        "custom",
        "/tmp/skills",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
    assert.throws(() =>
      ins.run(
        "ss_c",
        "C",
        "weird",
        "/tmp/other",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v10 migration creates secrets table with BLOB column", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasTable(db, "secrets"), true);
    for (const col of [
      "key",
      "encrypted_blob",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "secrets", col),
        true,
        `secrets is missing column ${col}`,
      );
    }
    const ins = db.prepare(
      `INSERT INTO secrets (key, encrypted_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    const blob = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    ins.run("openai_key", blob, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const row = db
      .prepare("SELECT encrypted_blob FROM secrets WHERE key = ?")
      .get("openai_key");
    assert.ok(row.encrypted_blob instanceof Buffer);
    assert.equal(row.encrypted_blob.toString("hex"), "deadbeef");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("readSchemaVersion reflects the new SCHEMA_VERSION after v10", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const v = readSchemaVersion(db);
    assert.equal(v, 10);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("applyMigrations is idempotent across two opens", () => {
  const t = tmp();
  let db = openDb({ filePath: t.file });
  closeDb(db);
  // Second open must not throw and must not duplicate rows.
  db = openDb({ filePath: t.file });
  try {
    applyMigrations(db); // explicit third pass — must be no-op
    const v = readSchemaVersion(db);
    assert.equal(v, 10);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("applyMigrations upgrades a pre-v7 DB without losing existing rows", () => {
  const t = tmp();
  // Bypass openDb() to simulate an old DB that lacks the new tables.
  const db = new Database(t.file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)`,
  ).run("harness_settings", JSON.stringify({ agent: { provider: "auto", timeoutMs: 300_000 } }));
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '6')`,
  ).run();

  try {
    applyMigrations(db);
    assert.equal(readSchemaVersion(db), 10);
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("harness_settings");
    assert.ok(row, "legacy settings row should survive the upgrade");
    assert.match(row.value, /"agent"/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
