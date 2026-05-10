/**
 * SQL schema for HarnessAgentOS canonical state.
 *
 * Source of truth: docs/architecture/harness-agent-os-design.md §14.
 * Phase 1 creates all 9 tables so subsequent phases can extend without
 * re-migrating. CHECK constraints encode the type unions from
 * docs/architecture/harness-agent-os-design.md §6.
 *
 * Every CREATE statement uses IF NOT EXISTS so applying the schema
 * repeatedly is a no-op (idempotency requirement from phase-01.md).
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    target_dir TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    user_request TEXT NOT NULL,
    target_dir TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('drafting','waiting_for_approval','running','paused','blocked','quality_failed','ready_for_review','done','cancelled')),
    current_step_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  )`,
  `CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped')),
    input_summary TEXT,
    output_summary TEXT,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    state_ref TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
    FOREIGN KEY(step_id) REFERENCES steps(id)
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('file_write','shell','dependency_install','git_commit','network','skill_script','orchestration_plan')),
    action_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run')),
    decision_message TEXT,
    decided_at TEXT,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
    FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    step_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('plan','diff','log','test_result','quality_report','orchestration_plan','file','snapshot')),
    title TEXT NOT NULL,
    uri TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
    FOREIGN KEY(step_id) REFERENCES steps(id)
  )`,
  `CREATE TABLE IF NOT EXISTS quality_gate_results (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('passed','failed','warning','not_run')),
    build_passed INTEGER,
    tests_passed INTEGER,
    smoke_passed INTEGER,
    changed_files_reviewed INTEGER,
    known_risks_json TEXT NOT NULL,
    evidence_artifact_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
  )`,
  `CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    trigger_terms_json TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    requires_approval INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS learning_traces (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    selected_model TEXT,
    selected_capabilities_json TEXT NOT NULL,
    reward REAL,
    cost_estimate REAL,
    latency_ms INTEGER,
    success INTEGER,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id)
  )`,
  // Helpful indices for common lookups. Idempotent.
  `CREATE INDEX IF NOT EXISTS idx_task_runs_thread_id ON task_runs(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_task_run_id ON steps(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_task_run_id ON checkpoints(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_task_run_id ON approvals(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_task_run_id ON artifacts(task_run_id)`,
];
