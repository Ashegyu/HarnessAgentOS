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
export const SCHEMA_VERSION = 12;

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
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run','executed')),
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
  // Phase 8 — agent invocation ledger (one row per CLI run).
  //
  // ON DELETE policy (see phase-08-agent-cli-integration.md "데이터 모델"):
  //   task_run_id          -> CASCADE   (invocation rows are TaskRun-scoped)
  //   step_id              -> SET NULL  (step may be pruned; metadata survives)
  //   prompt_artifact_id   -> RESTRICT  (reproducibility evidence — never lose)
  //   raw_output_artifact_id, parsed_plan_artifact_id -> SET NULL (cost/latency stays)
  //
  // Note: SQLite stores the FOREIGN KEY clauses inline at CREATE time;
  // updating them on an existing table requires a manual migration step.
  `CREATE TABLE IF NOT EXISTS agent_invocations (
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
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(step_id) REFERENCES steps(id) ON DELETE SET NULL,
    FOREIGN KEY(prompt_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
    FOREIGN KEY(raw_output_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
    FOREIGN KEY(parsed_plan_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL
  )`,

  // Phase 9 — user-configurable harness settings (single JSON row).
  // key is always 'harness_settings'; value is a JSON-encoded HarnessSettings.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // v7 — detailed agent profiles. Each row bundles persona, model tuning,
  // CLI environment, permissions, and references to MCP servers + skill
  // sources. See docs/design/agent-detailed-settings.md §4.1.
  `CREATE TABLE IF NOT EXISTS agent_profiles (
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
  )`,
  // Partial unique index — at most one profile carries is_default=1.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
    ON agent_profiles(is_default) WHERE is_default = 1`,

  // v8 — MCP server registry. See docs/design/agent-detailed-settings.md §4.2.
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL CHECK(transport IN ('stdio','http','sse')),
    command TEXT,
    args_json TEXT,
    url TEXT,
    env_json TEXT NOT NULL DEFAULT '{}',
    env_secret_refs_json TEXT NOT NULL DEFAULT '{}',
    scope TEXT NOT NULL CHECK(scope IN ('global','per-agent')),
    enabled INTEGER NOT NULL DEFAULT 1,
    last_health_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // v9 — trusted skill source registry. See agent-detailed-settings.md §4.3.
  `CREATE TABLE IF NOT EXISTS skill_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('project','user','custom')),
    root_dir TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    registered_in_path_policy INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(root_dir)
  )`,

  // v10 — encrypted secret vault. Each row holds an opaque BLOB produced
  // by Electron's safeStorage; plaintext lives only in the main process
  // at spawn time. Renderer is allowed to write/clear/listKeys but never
  // to read decrypted values.
  `CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    encrypted_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // v11 — AgentPipeline templates. Linear sequences of AgentProfile
  // references; OrchestrationPlanner expands these into WorkerStep arrays
  // when `pipelineId` is supplied. The steps JSON column carries an array
  // of AgentPipelineStep — FK strictness against agent_profiles is enforced
  // at the repository level, not the schema (JSON columns can't carry FK).
  `CREATE TABLE IF NOT EXISTS agent_pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL CHECK(json_array_length(steps_json) >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // Helpful indices for common lookups. Idempotent.
  `CREATE INDEX IF NOT EXISTS idx_task_runs_thread_id ON task_runs(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_task_run_id ON steps(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_task_run_id ON checkpoints(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_task_run_id ON approvals(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_task_run_id ON artifacts(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_invocations_task_run ON agent_invocations(task_run_id, created_at DESC)`,
];
