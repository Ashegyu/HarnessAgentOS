import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations, readSchemaVersion } from "./migrations.ts";
import { openDb, closeDb } from "./db.ts";
import { SCHEMA_VERSION } from "./schema.ts";

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
      "category",
      "tags_json",
      "provider",
      "role",
      "persona",
      "tuning_json",
      "cli_json",
      "permissions_json",
      "budget_json",
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

test("v23 migration adds nullable budget_json to agent_profiles", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(
      hasColumn(db, "agent_profiles", "budget_json"),
      true,
      "agent_profiles.budget_json must exist",
    );
    db.prepare(
      `INSERT INTO agent_profiles
        (id,name,description,provider,role,persona,tuning_json,cli_json,
         permissions_json,mcp_server_ids_json,skill_source_ids_json,
         is_default,created_at,updated_at)
       VALUES (?,?,'','claude','coder','','{}','{}','{}','[]','[]',0,?,?)`,
    ).run("ap_budget_null", "Budget Null", "2026-05-18T00:00:00.000Z", "2026-05-18T00:00:00.000Z");
    const row = db
      .prepare(`SELECT budget_json FROM agent_profiles WHERE id = ?`)
      .get("ap_budget_null");
    assert.equal(row.budget_json, null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v24 migration adds nullable auto_approve_decision_json to approvals", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(
      hasColumn(db, "approvals", "auto_approve_decision_json"),
      true,
      "approvals.auto_approve_decision_json must exist",
    );
    db.prepare(
      `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
       VALUES('thr_auto_decision', 'Thread', '/tmp/project', ?, ?)`,
    ).run("2026-05-18T00:00:00.000Z", "2026-05-18T00:00:00.000Z");
    db.prepare(
      `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
       VALUES('tsk_auto_decision', 'thr_auto_decision', 'Do it', '/tmp/project', 'drafting', NULL, ?, ?)`,
    ).run("2026-05-18T00:00:00.000Z", "2026-05-18T00:00:00.000Z");
    db.prepare(
      `INSERT INTO steps(id, task_run_id, step_index, kind, title, status)
       VALUES('stp_auto_decision', 'tsk_auto_decision', 0, 'approval', 'Approval', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
       VALUES('ckp_auto_decision', 'tsk_auto_decision', 'stp_auto_decision', 'before_edit', '{}', 'checkpoint', ?)`,
    ).run("2026-05-18T00:00:00.000Z");
    db.prepare(
      `INSERT INTO approvals(id, task_run_id, checkpoint_id, action_type, action_summary, status)
       VALUES('apv_auto_decision', 'tsk_auto_decision', 'ckp_auto_decision', 'file_write', 'Write file', 'pending')`,
    ).run();
    const row = db
      .prepare(`SELECT auto_approve_decision_json FROM approvals WHERE id = ?`)
      .get("apv_auto_decision");
    assert.equal(row.auto_approve_decision_json, null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v25 migration adds approvals decided_at index", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(
      hasIndex(db, "idx_approvals_decided_at"),
      true,
      "approvals.decided_at audit index must exist",
    );
    applyMigrations(db);
    assert.equal(hasIndex(db, "idx_approvals_decided_at"), true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v26 migration adds agent invocation profile budget columns and index", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(
      hasColumn(db, "agent_invocations", "profile_id"),
      true,
      "agent_invocations.profile_id must exist",
    );
    assert.equal(
      hasIndex(db, "idx_agent_invocations_profile_time"),
      true,
      "agent invocation profile/time budget index must exist",
    );
    applyMigrations(db);
    assert.equal(hasColumn(db, "agent_invocations", "profile_id"), true);
    assert.equal(hasIndex(db, "idx_agent_invocations_profile_time"), true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v26 migration upgrades existing agent_invocations before creating profile index", () => {
  const t = tmp();
  const db = new Database(t.file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE agent_invocations (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    step_id TEXT,
    provider TEXT NOT NULL CHECK(provider IN ('claude','codex')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
    prompt_artifact_id TEXT NOT NULL,
    raw_output_artifact_id TEXT,
    parsed_plan_artifact_id TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    latency_ms INTEGER,
    cost_estimate REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '25')`,
  ).run();

  try {
    applyMigrations(db);
    assert.equal(hasColumn(db, "agent_invocations", "profile_id"), true);
    assert.equal(hasIndex(db, "idx_agent_invocations_profile_time"), true);
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
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

test("v21 migration accepts expanded agent profile roles", () => {
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
    ins.run(
      "ap_security",
      "Security Reviewer",
      "claude",
      "security-reviewer",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    ins.run(
      "ap_build",
      "Build Resolver",
      "codex",
      "build-error-resolver",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const roles = db
      .prepare(`SELECT role FROM agent_profiles ORDER BY id`)
      .all()
      .map((row) => row.role);
    assert.deepEqual(roles, ["build-error-resolver", "security-reviewer"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v21 migration upgrades framework profile roles from legacy seed data", () => {
  const t = tmp();
  const db = new Database(t.file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    db.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL CHECK(provider IN ('auto','claude','codex')),
      role TEXT NOT NULL CHECK(role IN ('planner','coder','reviewer','tester')),
      persona TEXT NOT NULL DEFAULT '',
      tuning_json TEXT NOT NULL,
      cli_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      mcp_server_ids_json TEXT NOT NULL DEFAULT '[]',
      skill_source_ids_json TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.prepare(
      `INSERT INTO agent_profiles
        (id,name,description,provider,role,persona,tuning_json,cli_json,
         permissions_json,mcp_server_ids_json,skill_source_ids_json,
         is_default,created_at,updated_at)
       VALUES (?,?,'',?,?,'','{}','{}','{}','[]','[]',0,?,?)`,
    ).run(
      "ap_framework_ecc_security_reviewer",
      "ECC Security Reviewer",
      "claude",
      "reviewer",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    applyMigrations(db);

    const row = db
      .prepare(`SELECT role FROM agent_profiles WHERE id = ?`)
      .get("ap_framework_ecc_security_reviewer");
    assert.equal(row.role, "security-reviewer");
    assert.equal(hasColumn(db, "agent_profiles", "category"), true);
    assert.equal(hasColumn(db, "agent_profiles", "tags_json"), true);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v22 migration creates eval_runs with constraints and indexes", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasTable(db, "eval_runs"), true);
    for (const col of [
      "id",
      "suite",
      "started_at",
      "finished_at",
      "status",
      "summary_json",
      "harness_sha",
      "created_at",
    ]) {
      assert.equal(
        hasColumn(db, "eval_runs", col),
        true,
        `eval_runs is missing column ${col}`,
      );
    }
    assert.equal(hasIndex(db, "idx_eval_runs_started_at"), true);
    assert.equal(hasIndex(db, "idx_eval_runs_suite_status"), true);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO eval_runs(id, suite, started_at, status, summary_json)
         VALUES('evrun_bad', 'capability', ?, 'INVALID', '{}')`,
      ).run("2026-01-01T00:00:00.000Z");
    });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v22 migration is idempotent", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    applyMigrations(db);
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
    assert.equal(hasTable(db, "eval_runs"), true);
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

test("readSchemaVersion reflects the current SCHEMA_VERSION", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const v = readSchemaVersion(db);
    assert.equal(v, SCHEMA_VERSION);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v20 migration adds profile taxonomy columns", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(hasColumn(db, "agent_profiles", "category"), true);
    assert.equal(hasColumn(db, "agent_profiles", "tags_json"), true);
    db.prepare(
      `INSERT INTO agent_profiles
        (id,name,description,provider,role,persona,tuning_json,cli_json,
         permissions_json,mcp_server_ids_json,skill_source_ids_json,
         is_default,created_at,updated_at)
       VALUES (?,?,'','claude','coder','','{}','{}','{}','[]','[]',0,?,?)`,
    ).run("ap_tax", "Taxonomy", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const row = db
      .prepare("SELECT category, tags_json FROM agent_profiles WHERE id = ?")
      .get("ap_tax");
    assert.equal(row.category, "core");
    assert.equal(row.tags_json, "[]");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v13 migration allows capability_use approval action type", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    db.prepare(
      `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(
      "thr_cap",
      "t",
      "/tmp/proj",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      "tsk_cap",
      "thr_cap",
      "refactor",
      "/tmp/proj",
      "drafting",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO steps(id, task_run_id, step_index, kind, title, status)
       VALUES(?, ?, 0, 'approval', 'Skill 후보', 'pending')`,
    ).run("stp_cap", "tsk_cap");
    db.prepare(
      `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
       VALUES(?, ?, ?, 'before_edit', '{}', 'skill candidate', ?)`,
    ).run("ckp_cap", "tsk_cap", "stp_cap", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO approvals(id, task_run_id, checkpoint_id, action_type, action_summary, status)
       VALUES(?, ?, ?, 'capability_use', ?, 'pending')`,
    ).run("apv_cap", "tsk_cap", "ckp_cap", "Use skill");
    const row = db
      .prepare(`SELECT action_type FROM approvals WHERE id = ?`)
      .get("apv_cap");
    assert.equal(row.action_type, "capability_use");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v14 migration allows model_use approval action type", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    db.prepare(
      `INSERT INTO threads(id, title, target_dir, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(
      "thr_model",
      "t",
      "/tmp/proj",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      "tsk_model",
      "thr_model",
      "analyze",
      "/tmp/proj",
      "drafting",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO steps(id, task_run_id, step_index, kind, title, status)
       VALUES(?, ?, 0, 'approval', 'Learner 추천', 'pending')`,
    ).run("stp_model", "tsk_model");
    db.prepare(
      `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
       VALUES(?, ?, ?, 'before_edit', '{}', 'learner recommendation', ?)`,
    ).run(
      "ckp_model",
      "tsk_model",
      "stp_model",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO approvals(id, task_run_id, checkpoint_id, action_type, action_summary, status)
       VALUES(?, ?, ?, 'model_use', ?, 'pending')`,
    ).run("apv_model", "tsk_model", "ckp_model", "Use model");
    const row = db
      .prepare(`SELECT action_type FROM approvals WHERE id = ?`)
      .get("apv_model");
    assert.equal(row.action_type, "model_use");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v16 migration creates observation, instinct, and evolution candidate tables", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    for (const table of [
      "observations",
      "instincts",
      "evolution_candidates",
    ]) {
      assert.equal(hasTable(db, table), true, `${table} table must exist`);
    }
    for (const col of [
      "id",
      "task_run_id",
      "thread_id",
      "project_key",
      "source",
      "event_type",
      "signal",
      "summary",
      "payload_json",
      "created_at",
    ]) {
      assert.equal(
        hasColumn(db, "observations", col),
        true,
        `observations is missing column ${col}`,
      );
    }
    for (const col of [
      "id",
      "project_key",
      "scope",
      "title",
      "rule",
      "rationale",
      "confidence",
      "status",
      "source_observation_ids_json",
      "tags_json",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "instincts", col),
        true,
        `instincts is missing column ${col}`,
      );
    }
    for (const col of [
      "id",
      "project_key",
      "title",
      "proposed_rule",
      "rationale",
      "confidence",
      "status",
      "observation_ids_json",
      "created_at",
      "updated_at",
    ]) {
      assert.equal(
        hasColumn(db, "evolution_candidates", col),
        true,
        `evolution_candidates is missing column ${col}`,
      );
    }
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO instincts(
             id, scope, title, rule, rationale, confidence, status,
             source_observation_ids_json, tags_json, created_at, updated_at
           ) VALUES(
             'ins_bad', 'task_run', 'bad', 'bad', 'bad', 0.3, 'active',
             '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
           )`,
        )
        .run(),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("v17 migration adds policy_evaluation_json to approvals", () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    assert.equal(
      hasColumn(db, "approvals", "policy_evaluation_json"),
      true,
      "approvals.policy_evaluation_json must exist",
    );
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
    assert.equal(v, SCHEMA_VERSION);
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
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("harness_settings");
    assert.ok(row, "legacy settings row should survive the upgrade");
    assert.match(row.value, /"agent"/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
