/**
 * SQL schema for HarnessAgentOS canonical state.
 *
 * Source of truth: docs/architecture/harness-agent-os-design.md §14.
 * Phase 1 created the base tables; later phases append domain tables without
 * re-migrating. CHECK constraints encode the type unions from
 * docs/architecture/harness-agent-os-design.md §6.
 *
 * Every CREATE statement uses IF NOT EXISTS so applying the schema
 * repeatedly is a no-op (idempotency requirement from phase-01.md).
 */
export const SCHEMA_VERSION = 35;

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
    follow_up_task_run_id TEXT,
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
    action_type TEXT NOT NULL CHECK(action_type IN ('capability_use','model_use','file_write','shell','dependency_install','git_commit','network','skill_script','orchestration_plan')),
    action_summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','always_approved_for_run','executed')),
    decision_message TEXT,
    decided_at TEXT,
    proposed_action_json TEXT,
    policy_evaluation_json TEXT,
    auto_approve_decision_json TEXT,
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
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    task_run_id TEXT,
    thread_id TEXT,
    project_key TEXT,
    source TEXT NOT NULL CHECK(source IN ('approval','quality','learner','runner','skill','agent')),
    event_type TEXT NOT NULL,
    signal TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id),
    FOREIGN KEY(thread_id) REFERENCES threads(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_observations_project_created
    ON observations(project_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_observations_task_run
    ON observations(task_run_id)`,
  `CREATE TABLE IF NOT EXISTS instincts (
    id TEXT PRIMARY KEY,
    project_key TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('global','project','thread')),
    title TEXT NOT NULL,
    rule TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','disabled','rejected')),
    source_observation_ids_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_instincts_scope_project_status
    ON instincts(scope, project_key, status)`,
  `CREATE TABLE IF NOT EXISTS evolution_candidates (
    id TEXT PRIMARY KEY,
    project_key TEXT,
    title TEXT NOT NULL,
    proposed_rule TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','stale')),
    observation_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evolution_candidates_project_status
    ON evolution_candidates(project_key, status)`,
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
    profile_id TEXT,
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
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    usage_approximate INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(step_id) REFERENCES steps(id) ON DELETE SET NULL,
    FOREIGN KEY(profile_id) REFERENCES agent_profiles(id) ON DELETE SET NULL,
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
    category TEXT NOT NULL DEFAULT 'core',
    tags_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL CHECK(provider IN ('auto','claude','codex')),
    role TEXT NOT NULL CHECK(role IN ('planner','coder','reviewer','tester','orchestrator','security-reviewer','build-error-resolver','refactor-cleaner','performance-reviewer','documenter')),
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

  // v33 — imported harness package declarations. These rows store source
  // package snapshots and validation diagnostics only; runtime execution state
  // remains in TaskRun/Step/Approval/Artifact tables.
  `CREATE TABLE IF NOT EXISTS harness_packages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK(source_format IN ('claude','codex','harness-native')),
    root_dir TEXT NOT NULL,
    validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','valid_with_warnings','needs_review','unsupported')),
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_packages_format_status
    ON harness_packages(source_format, validation_status, updated_at DESC)`,

  // v35 — reusable bindings from imported harness agents/roles to concrete
  // AgentProfiles. Direct harness orchestration reads these rows at question
  // time and does not need to create an AgentPipeline template.
  `CREATE TABLE IF NOT EXISTS harness_binding_sets (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL CHECK(length(package_id) > 0),
    workflow_id TEXT NOT NULL CHECK(length(workflow_id) > 0),
    name TEXT NOT NULL CHECK(length(name) > 0),
    bindings_json TEXT NOT NULL CHECK(json_valid(bindings_json) AND json_type(bindings_json) = 'array'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(package_id) REFERENCES harness_packages(id) ON DELETE CASCADE,
    UNIQUE(package_id, workflow_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_binding_sets_package_workflow
    ON harness_binding_sets(package_id, workflow_id, updated_at DESC)`,

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
    backflow_rules_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // v30 — Pipeline-level conditional backflow ledger. This is separate
  // from A2A refinement attempts: backflow is runtime routing inside an
  // approved pipeline, not remote result feedback.
  `CREATE TABLE IF NOT EXISTS pipeline_backflow_attempts (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('step_failed','quality_failed')),
    target_step_id TEXT NOT NULL,
    retry_step_id TEXT NOT NULL,
    max_attempts INTEGER NOT NULL,
    attempt_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','max_attempts_reached')),
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_backflow_attempts_task_run
    ON pipeline_backflow_attempts(task_run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_backflow_attempts_rule
    ON pipeline_backflow_attempts(task_run_id, plan_id, rule_id, trigger, attempt_index)`,
  `CREATE TABLE IF NOT EXISTS pipeline_backflow_events (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('triggered','target_started','target_succeeded','retry_started','retry_succeeded','failed','max_attempts_reached')),
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','max_attempts_reached')),
    summary TEXT NOT NULL,
    reason TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id) REFERENCES pipeline_backflow_attempts(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_backflow_events_created
    ON pipeline_backflow_events(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pipeline_backflow_events_attempt
    ON pipeline_backflow_events(attempt_id, created_at)`,

  // v15 — remote A2A agent registry. This is registry-only state; actual
  // remote invocation stays behind an adapter and is not part of Phase B.
  `CREATE TABLE IF NOT EXISTS a2a_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    agent_card_url TEXT NOT NULL,
    preferred_transport TEXT NOT NULL CHECK(preferred_transport IN ('json-rpc','http-json','grpc')),
    enabled INTEGER NOT NULL,
    trusted INTEGER NOT NULL,
    auth_secret_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_agent_card_snapshots (
    endpoint_id TEXT PRIMARY KEY,
    protocol_version TEXT,
    agent_name TEXT NOT NULL,
    description TEXT,
    version TEXT,
    skills_json TEXT NOT NULL,
    input_modes_json TEXT NOT NULL,
    output_modes_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    etag TEXT,
    raw_card_json TEXT NOT NULL,
    FOREIGN KEY(endpoint_id) REFERENCES a2a_endpoints(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS a2a_remote_tasks (
    invocation_id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    remote_task_id TEXT,
    remote_context_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('submitted','working','input-required','auth-required','completed','failed','canceled','rejected','unknown')),
    last_event_at TEXT,
    FOREIGN KEY(invocation_id) REFERENCES agent_invocations(id) ON DELETE CASCADE,
    FOREIGN KEY(endpoint_id) REFERENCES a2a_endpoints(id) ON DELETE CASCADE
  )`,

  // v28 — Harness-owned A2A refinement/backflow attempt ledger.
  `CREATE TABLE IF NOT EXISTS a2a_refinement_attempts (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    target_invocation_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    feedback_source_kind TEXT NOT NULL CHECK(feedback_source_kind IN ('user','quality_gate','worker','system')),
    feedback_source_step_id TEXT,
    feedback_source_invocation_id TEXT,
    feedback_artifact_id TEXT,
    quality_gate_id TEXT,
    parent_remote_task_id TEXT,
    parent_remote_context_id TEXT,
    remote_task_id TEXT,
    remote_context_id TEXT,
    reference_task_ids_json TEXT NOT NULL,
    reference_artifact_ids_json TEXT NOT NULL,
    feedback_signature TEXT NOT NULL,
    attempt_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','running','input_required','auth_required','succeeded','failed','stopped','cancelled')),
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(target_invocation_id) REFERENCES agent_invocations(id) ON DELETE CASCADE,
    FOREIGN KEY(endpoint_id) REFERENCES a2a_endpoints(id) ON DELETE CASCADE,
    FOREIGN KEY(feedback_source_step_id) REFERENCES steps(id) ON DELETE SET NULL,
    FOREIGN KEY(feedback_source_invocation_id) REFERENCES agent_invocations(id) ON DELETE SET NULL,
    FOREIGN KEY(feedback_artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
    FOREIGN KEY(quality_gate_id) REFERENCES quality_gate_results(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_task_run
    ON a2a_refinement_attempts(task_run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_target
    ON a2a_refinement_attempts(target_invocation_id, attempt_index)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_signature
    ON a2a_refinement_attempts(task_run_id, target_invocation_id, feedback_signature)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_active_signature
    ON a2a_refinement_attempts(task_run_id, target_invocation_id, feedback_signature)
    WHERE status IN ('pending_approval','queued','running','input_required','auth_required')`,
  `CREATE TABLE IF NOT EXISTS a2a_refinement_events (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('created','started','succeeded','failed','stopped','cancelled','input_required','auth_required')),
    status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','running','input_required','auth_required','succeeded','failed','stopped','cancelled')),
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(attempt_id) REFERENCES a2a_refinement_attempts(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_refinement_events_created
    ON a2a_refinement_events(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_refinement_events_attempt
    ON a2a_refinement_events(attempt_id, created_at)`,

  // v18 — deterministic repository context index. SQLite remains the
  // canonical state; scan output is cached here and packed into agent prompts.
  `CREATE TABLE IF NOT EXISTS repo_index_files (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    target_dir TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_kind TEXT NOT NULL CHECK(file_kind IN ('package','config','source','test','doc','style','other')),
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    summary TEXT NOT NULL,
    symbols_json TEXT NOT NULL DEFAULT '[]',
    imports_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    UNIQUE(project_key, target_dir, relative_path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_repo_index_target
    ON repo_index_files(project_key, target_dir, updated_at)`,

  // v19 — quality repair loop attempt ledger. Attempts remain in the same
  // TaskRun history and make repeated failure signatures stoppable.
  `CREATE TABLE IF NOT EXISTS repair_attempts (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL,
    quality_gate_id TEXT NOT NULL,
    attempt_index INTEGER NOT NULL,
    failure_signature TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planned','waiting_for_approval','executed','passed','failed','stopped')),
    invocation_id TEXT,
    generated_approval_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(quality_gate_id) REFERENCES quality_gate_results(id) ON DELETE CASCADE,
    FOREIGN KEY(invocation_id) REFERENCES agent_invocations(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_repair_attempts_task_run
    ON repair_attempts(task_run_id, attempt_index)`,
  `CREATE INDEX IF NOT EXISTS idx_repair_attempts_signature
    ON repair_attempts(task_run_id, failure_signature)`,

  // v22 — meta-evaluation run summaries. Attempts can also be written as
  // workspace artifacts; this table keeps recent run lookup and trend queries
  // fast without exposing eval state through renderer IPC.
  `CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    suite TEXT NOT NULL CHECK(suite IN ('capability','regression','safety','all')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','partial')),
    summary_json TEXT NOT NULL,
    harness_sha TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_runs_started_at
    ON eval_runs(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_runs_suite_status
    ON eval_runs(suite, status)`,

  // Helpful indices for common lookups. Idempotent.
  `CREATE INDEX IF NOT EXISTS idx_task_runs_thread_id ON task_runs(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_task_run_id ON steps(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_task_run_id ON checkpoints(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_task_run_id ON approvals(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_decided_at ON approvals(decided_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_task_run_id ON artifacts(task_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_invocations_task_run ON agent_invocations(task_run_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_endpoints_enabled ON a2a_endpoints(enabled, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_a2a_remote_tasks_endpoint ON a2a_remote_tasks(endpoint_id)`,
];
