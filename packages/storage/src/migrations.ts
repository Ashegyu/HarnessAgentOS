import type { Database as DatabaseType } from "better-sqlite3";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.ts";

const APPROVAL_ACTION_TYPE_CHECK =
  "'capability_use','model_use','file_patch','file_write','shell','dependency_install','git_commit','network','skill_script','orchestration_plan'";
const AGENT_PROFILE_ROLE_CHECK =
  "'planner','coder','reviewer','tester','orchestrator','security-reviewer','build-error-resolver','refactor-cleaner','performance-reviewer','documenter'";

/**
 * Idempotent migration runner. Phase 1 ships schema v1 covering all
 * base tables defined in docs/architecture/harness-agent-os-design.md §14.
 * Subsequent phases append table/column steps below; each is a no-op if
 * the object already exists, so applying migrations multiple times
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

    // v17 — policy_evaluation_json on approvals. Stores the service-layer
    // policy decision that renderer auto-approve must honor.
    if (!hasColumn(db, "approvals", "policy_evaluation_json")) {
      db.exec(`ALTER TABLE approvals ADD COLUMN policy_evaluation_json TEXT`);
    }

    // v24 — nullable decision trace for renderer auto-approve decisions.
    if (!hasColumn(db, "approvals", "auto_approve_decision_json")) {
      db.exec(`ALTER TABLE approvals ADD COLUMN auto_approve_decision_json TEXT`);
    }

    // v25 — global decision audit log ordering. Kept separate from the
    // task-run index because Activity Log queries page by decision time.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_approvals_decided_at
        ON approvals(decided_at DESC)`,
    );

    // v26 — actual CLI invocation cost is budgeted against the profile
    // that launched it. Existing rows remain unassigned.
    if (!hasColumn(db, "agent_invocations", "profile_id")) {
      db.exec(`ALTER TABLE agent_invocations ADD COLUMN profile_id TEXT`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_invocations_profile_time
        ON agent_invocations(profile_id, finished_at, created_at)`,
    );

    // v27 — token usage is the primary usage metric. USD estimates remain
    // optional because provider pricing can be unavailable or unverified.
    if (!hasColumn(db, "agent_invocations", "input_tokens")) {
      db.exec(`ALTER TABLE agent_invocations ADD COLUMN input_tokens INTEGER`);
    }
    if (!hasColumn(db, "agent_invocations", "output_tokens")) {
      db.exec(`ALTER TABLE agent_invocations ADD COLUMN output_tokens INTEGER`);
    }
    if (!hasColumn(db, "agent_invocations", "total_tokens")) {
      db.exec(`ALTER TABLE agent_invocations ADD COLUMN total_tokens INTEGER`);
    }
    if (!hasColumn(db, "agent_invocations", "usage_approximate")) {
      db.exec(`ALTER TABLE agent_invocations ADD COLUMN usage_approximate INTEGER`);
    }

    // v23 — nullable per-profile budget caps. Stored separately from
    // permissions_json so old profile rows remain valid and empty caps stay NULL.
    if (!hasColumn(db, "agent_profiles", "budget_json")) {
      db.exec(`ALTER TABLE agent_profiles ADD COLUMN budget_json TEXT`);
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

    // v31 — explicit per-TaskRun follow-up anchor. This lets a new task
    // continue a specific previous task in the same thread without relying
    // on the agent to infer intent from chronological history alone.
    if (!hasColumn(db, "task_runs", "follow_up_task_run_id")) {
      db.exec(`ALTER TABLE task_runs ADD COLUMN follow_up_task_run_id TEXT`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_task_runs_follow_up
        ON task_runs(follow_up_task_run_id)`,
    );

    // v30 — pipeline-level conditional backflow rules. Existing pipeline
    // templates default to no backflow edges.
    if (!hasColumn(db, "agent_pipelines", "backflow_rules_json")) {
      db.exec(
        `ALTER TABLE agent_pipelines ADD COLUMN backflow_rules_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }

    // v20 — profile taxonomy for framework-derived agents. `role` stays
    // the execution-stage contract; category/tags express specialisation.
    if (!hasColumn(db, "agent_profiles", "category")) {
      db.exec(`ALTER TABLE agent_profiles ADD COLUMN category TEXT NOT NULL DEFAULT 'core'`);
    }
    if (!hasColumn(db, "agent_profiles", "tags_json")) {
      db.exec(`ALTER TABLE agent_profiles ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`);
    }
    const agentProfileRolesAreExpanded = agentProfileRoleAllows(
      db,
      "documenter",
    );
    if (!agentProfileRolesAreExpanded) {
      rebuildAgentProfiles(db);
      upgradeFrameworkAgentProfileRoles(db);
    }

    // v6 — expand approvals.status CHECK to include 'executed'.
    // SQLite doesn't support ALTER CONSTRAINT; the table must be rebuilt.
    if (!approvalStatusAllows(db, "executed")) {
      rebuildApprovals(db);
    }

    // v13 — add capability_use approvals for Skillify candidate selection.
    // This is not runner-executed; it gates whether approved skill
    // instructions may be injected into a later agent prompt.
    if (!approvalActionTypeAllows(db, "capability_use")) {
      rebuildApprovals(db);
    }

    // v14 — add model_use approvals for Learner model recommendations.
    // Like capability_use, this is consent to shape the next agent
    // invocation, not a runner-executed side effect.
    if (!approvalActionTypeAllows(db, "model_use")) {
      rebuildApprovals(db);
    }

    // v36 — add file_patch approvals for single-file unified diff changes.
    if (!approvalActionTypeAllows(db, "file_patch")) {
      rebuildApprovals(db);
    }

    // v34 — repaired harness package snapshots may share the same source
    // root_dir as the original import. The row id identifies each immutable
    // declaration snapshot; root_dir is source provenance, not uniqueness.
    if (harnessPackageRootDirIsUnique(db)) {
      rebuildHarnessPackages(db);
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

const approvalActionTypeAllows = (
  db: DatabaseType,
  actionType: string,
): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'`)
    .get() as { sql: string } | undefined;
  return row?.sql?.includes(`'${actionType}'`) ?? false;
};

const agentProfileRoleAllows = (
  db: DatabaseType,
  role: string,
): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_profiles'`)
    .get() as { sql: string } | undefined;
  return row?.sql?.includes(`'${role}'`) ?? false;
};

const harnessPackageRootDirIsUnique = (db: DatabaseType): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_packages'`)
    .get() as { sql: string } | undefined;
  return /\bUNIQUE\s*\(\s*root_dir\s*\)/i.test(row?.sql ?? "");
};

const rebuildAgentProfiles = (db: DatabaseType): void => {
  db.exec(`DROP INDEX IF EXISTS idx_agent_profiles_default`);
  db.exec(`ALTER TABLE agent_profiles RENAME TO agent_profiles_migration_old`);
  db.exec(`CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'core',
    tags_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL CHECK(provider IN ('auto','claude','codex')),
    role TEXT NOT NULL CHECK(role IN (${AGENT_PROFILE_ROLE_CHECK})),
    persona TEXT NOT NULL DEFAULT '',
    tuning_json TEXT NOT NULL,
    cli_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    budget_json TEXT,
    mcp_server_ids_json TEXT NOT NULL DEFAULT '[]',
    skill_source_ids_json TEXT NOT NULL DEFAULT '[]',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`INSERT INTO agent_profiles (
      id,name,description,category,tags_json,provider,role,persona,
      tuning_json,cli_json,permissions_json,budget_json,mcp_server_ids_json,
      skill_source_ids_json,is_default,created_at,updated_at
    )
    SELECT
      id,name,description,category,tags_json,provider,role,persona,
      tuning_json,cli_json,permissions_json,budget_json,mcp_server_ids_json,
      skill_source_ids_json,is_default,created_at,updated_at
    FROM agent_profiles_migration_old`);
  db.exec(`DROP TABLE agent_profiles_migration_old`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
    ON agent_profiles(is_default) WHERE is_default = 1`);
};

const upgradeFrameworkAgentProfileRoles = (db: DatabaseType): void => {
  const updates = [
    ["ap_framework_ruflo_orchestrator", "orchestrator"],
    ["ap_framework_agno_trace_planner", "orchestrator"],
    ["ap_framework_ecc_refactor_cleaner", "refactor-cleaner"],
    ["ap_framework_ecc_build_resolver", "build-error-resolver"],
    ["ap_framework_ecc_security_reviewer", "security-reviewer"],
    ["ap_framework_dotnet_performance_reviewer", "performance-reviewer"],
  ] as const;
  const stmt = db.prepare(
    `UPDATE agent_profiles SET role = ? WHERE id = ? AND role != ?`,
  );
  for (const [id, role] of updates) {
    stmt.run(role, id, role);
  }
};

const rebuildApprovals = (db: DatabaseType): void => {
  db.exec(`ALTER TABLE approvals RENAME TO approvals_migration_old`);
  db.exec(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN (${APPROVAL_ACTION_TYPE_CHECK})),
    action_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run','executed')),
    decision_message TEXT,
    decided_at TEXT,
    proposed_action_json TEXT,
    policy_evaluation_json TEXT,
    auto_approve_decision_json TEXT,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
    FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
  )`);
  db.exec(`INSERT INTO approvals SELECT id,task_run_id,checkpoint_id,action_type,action_summary,status,decision_message,decided_at,proposed_action_json,policy_evaluation_json,auto_approve_decision_json FROM approvals_migration_old`);
  db.exec(`DROP TABLE approvals_migration_old`);
};

const rebuildHarnessPackages = (db: DatabaseType): void => {
  db.exec(`DROP INDEX IF EXISTS idx_harness_packages_format_status`);
  db.exec(`ALTER TABLE harness_packages RENAME TO harness_packages_migration_old`);
  db.exec(`CREATE TABLE harness_packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK(source_format IN ('claude','codex','harness-native')),
    root_dir TEXT NOT NULL,
    validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','valid_with_warnings','needs_review','unsupported')),
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`INSERT INTO harness_packages (
      id,name,source_format,root_dir,validation_status,
      definition_json,created_at,updated_at
    )
    SELECT
      id,name,source_format,root_dir,validation_status,
      definition_json,created_at,updated_at
    FROM harness_packages_migration_old`);
  db.exec(`DROP TABLE harness_packages_migration_old`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_harness_packages_format_status
    ON harness_packages(source_format, validation_status, updated_at DESC)`);
};

export const readSchemaVersion = (db: DatabaseType): number | null => {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  const v = Number.parseInt(row.value, 10);
  return Number.isFinite(v) ? v : null;
};
