export interface HarnessError {
  code: string;
  message: string;
  details?: unknown;
}

export const harnessError = (
  code: string,
  message: string,
  details?: unknown,
): HarnessError => {
  const e: HarnessError = { code, message };
  if (details !== undefined) e.details = details;
  return e;
};

export const isHarnessError = (value: unknown): value is HarnessError => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.message === "string";
};

// Phase 0
export const APP_RUNTIME_UNAVAILABLE = "APP_RUNTIME_UNAVAILABLE" as const;
export const IPC_CHANNEL_NOT_ALLOWED = "IPC_CHANNEL_NOT_ALLOWED" as const;
export const IPC_INVALID_PAYLOAD = "IPC_INVALID_PAYLOAD" as const;

// Phase 1 - state namespace
export const STATE_THREAD_NOT_FOUND = "STATE_THREAD_NOT_FOUND" as const;
export const STATE_INVALID_INPUT = "STATE_INVALID_INPUT" as const;
export const STATE_DB_ERROR = "STATE_DB_ERROR" as const;

// Phase 2 - conversation namespace
export const CONVERSATION_EMPTY_REQUEST = "CONVERSATION_EMPTY_REQUEST" as const;
export const CONVERSATION_INVALID_TARGET_DIR =
  "CONVERSATION_INVALID_TARGET_DIR" as const;
export const CONVERSATION_TASK_NOT_FOUND = "CONVERSATION_TASK_NOT_FOUND" as const;
export const APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND" as const;
export const APPROVAL_MESSAGE_REQUIRED = "APPROVAL_MESSAGE_REQUIRED" as const;
export const CONVERSATION_INVALID_STATE =
  "CONVERSATION_INVALID_STATE" as const;
export const CONVERSATION_NOTHING_TO_RESUME =
  "CONVERSATION_NOTHING_TO_RESUME" as const;
export const CONVERSATION_REASON_REQUIRED =
  "CONVERSATION_REASON_REQUIRED" as const;
export const CONVERSATION_PROPOSED_ACTION_TYPE_MISMATCH =
  "CONVERSATION_PROPOSED_ACTION_TYPE_MISMATCH" as const;

// Phase 3 - runner namespace
export const RUNNER_APPROVAL_REQUIRED = "RUNNER_APPROVAL_REQUIRED" as const;
export const RUNNER_APPROVAL_REJECTED = "RUNNER_APPROVAL_REJECTED" as const;
export const RUNNER_TARGET_OUTSIDE_WORKSPACE =
  "RUNNER_TARGET_OUTSIDE_WORKSPACE" as const;
export const RUNNER_BLOCKED_HIGH_RISK = "RUNNER_BLOCKED_HIGH_RISK" as const;
export const RUNNER_EXECUTION_FAILED = "RUNNER_EXECUTION_FAILED" as const;
export const RUNNER_RETRY_NOT_BLOCKED = "RUNNER_RETRY_NOT_BLOCKED" as const;
export const ARTIFACT_NOT_FOUND = "ARTIFACT_NOT_FOUND" as const;

// Phase 4 - quality namespace
export const QUALITY_TASK_NOT_FOUND = "QUALITY_TASK_NOT_FOUND" as const;
export const QUALITY_EVIDENCE_MISSING = "QUALITY_EVIDENCE_MISSING" as const;
export const QUALITY_RISK_MESSAGE_REQUIRED =
  "QUALITY_RISK_MESSAGE_REQUIRED" as const;
export const QUALITY_DONE_BLOCKED = "QUALITY_DONE_BLOCKED" as const;

// Phase 5 - capability namespace
// Canonical names match docs/contracts/ipc-contracts.md. The legacy
// `CAPABILITY_UNTRUSTED_SCRIPT` / `CAPABILITY_SCRIPT_TRAVERSAL` aliases
// stay for one release so existing callers don't break.
export const CAPABILITY_NOT_FOUND = "CAPABILITY_NOT_FOUND" as const;
export const CAPABILITY_UNTRUSTED_SKILL =
  "CAPABILITY_UNTRUSTED_SKILL" as const;
/** @deprecated use CAPABILITY_UNTRUSTED_SKILL */
export const CAPABILITY_UNTRUSTED_SCRIPT = CAPABILITY_UNTRUSTED_SKILL;
export const CAPABILITY_SCRIPT_NOT_FOUND =
  "CAPABILITY_SCRIPT_NOT_FOUND" as const;
export const CAPABILITY_SCRIPT_REQUIRES_APPROVAL =
  "CAPABILITY_SCRIPT_REQUIRES_APPROVAL" as const;
export const CAPABILITY_REFRESH_FAILED = "CAPABILITY_REFRESH_FAILED" as const;
export const CAPABILITY_SCRIPT_TRAVERSAL =
  "CAPABILITY_SCRIPT_TRAVERSAL" as const;

// Phase 6 - learner namespace
export const LEARNER_TASK_NOT_FOUND = "LEARNER_TASK_NOT_FOUND" as const;
export const LEARNER_TRACE_NOT_FOUND = "LEARNER_TRACE_NOT_FOUND" as const;
export const LEARNER_RECOMMENDATION_NOT_FOUND =
  "LEARNER_RECOMMENDATION_NOT_FOUND" as const;
export const LEARNER_INVALID_DECISION = "LEARNER_INVALID_DECISION" as const;
/** @deprecated use LEARNER_INVALID_DECISION */
export const LEARNER_DECISION_INVALID = LEARNER_INVALID_DECISION;
export const TOPOLOGY_TASK_NOT_FOUND = "TOPOLOGY_TASK_NOT_FOUND" as const;

// Agent Framework adoption — user-reviewed evolution candidates.
export const INSTINCT_CANDIDATE_NOT_FOUND =
  "INSTINCT_CANDIDATE_NOT_FOUND" as const;
export const INSTINCT_CANDIDATE_INVALID_STATE =
  "INSTINCT_CANDIDATE_INVALID_STATE" as const;
export const INSTINCT_NOT_FOUND = "INSTINCT_NOT_FOUND" as const;

// Phase 7 - orchestration namespace
// Canonical names match docs/contracts/ipc-contracts.md (`ORCHESTRATION_*`).
// Short-form `ORCH_*` aliases remain for one release.
export const ORCHESTRATION_DISABLED = "ORCHESTRATION_DISABLED" as const;
export const ORCHESTRATION_PLAN_NOT_FOUND =
  "ORCHESTRATION_PLAN_NOT_FOUND" as const;
export const ORCHESTRATION_APPROVAL_REQUIRED =
  "ORCHESTRATION_APPROVAL_REQUIRED" as const;
export const ORCHESTRATION_APPROVAL_TYPE_MISMATCH =
  "ORCHESTRATION_APPROVAL_TYPE_MISMATCH" as const;
export const ORCHESTRATION_INVALID_PLAN = "ORCHESTRATION_INVALID_PLAN" as const;
export const ORCHESTRATION_TASK_NOT_FOUND =
  "ORCHESTRATION_TASK_NOT_FOUND" as const;
export const ORCHESTRATION_DIRECT_ACTION_BLOCKED =
  "ORCHESTRATION_DIRECT_ACTION_BLOCKED" as const;

// Legacy short-form aliases — prefer the long-form constants above.
/** @deprecated use ORCHESTRATION_TASK_NOT_FOUND */
export const ORCH_TASK_NOT_FOUND = ORCHESTRATION_TASK_NOT_FOUND;
/** @deprecated use ORCHESTRATION_INVALID_PLAN */
export const ORCH_INVALID_PLAN = ORCHESTRATION_INVALID_PLAN;
/** @deprecated use ORCHESTRATION_APPROVAL_REQUIRED */
export const ORCH_APPROVAL_NOT_APPROVED = ORCHESTRATION_APPROVAL_REQUIRED;
/** @deprecated use ORCHESTRATION_APPROVAL_TYPE_MISMATCH */
export const ORCH_APPROVAL_TYPE_MISMATCH = ORCHESTRATION_APPROVAL_TYPE_MISMATCH;
/** @deprecated use ORCHESTRATION_DIRECT_ACTION_BLOCKED */
export const ORCH_DIRECT_ACTION_BLOCKED = ORCHESTRATION_DIRECT_ACTION_BLOCKED;
/** @deprecated use ORCHESTRATION_PLAN_NOT_FOUND */
export const ORCH_PLAN_NOT_FOUND = ORCHESTRATION_PLAN_NOT_FOUND;

// Phase 8 - agent namespace
export const AGENT_SPAWN_FAILED = "AGENT_SPAWN_FAILED" as const;
export const AGENT_CANCELLED = "AGENT_CANCELLED" as const;
export const AGENT_STALL = "AGENT_STALL" as const;
export const AGENT_TIMEOUT = "AGENT_TIMEOUT" as const;
export const AGENT_INVALID_OUTPUT = "AGENT_INVALID_OUTPUT" as const;
export const AGENT_RATE_LIMITED = "AGENT_RATE_LIMITED" as const;
export const AGENT_PROVIDER_UNAVAILABLE =
  "AGENT_PROVIDER_UNAVAILABLE" as const;
export const AGENT_PROPOSED_ACTION_INVALID =
  "AGENT_PROPOSED_ACTION_INVALID" as const;
export const AGENT_INVOCATION_NOT_FOUND =
  "AGENT_INVOCATION_NOT_FOUND" as const;
export const AGENT_TASK_RUN_NOT_FOUND = "AGENT_TASK_RUN_NOT_FOUND" as const;
export const AGENT_MODE_MISMATCH = "AGENT_MODE_MISMATCH" as const;
export const AGENT_INVOCATION_BUSY = "AGENT_INVOCATION_BUSY" as const;

// Detailed-settings (Phase 3) — see docs/design/agent-detailed-settings.md.
export const AGENT_PROFILE_NOT_FOUND = "AGENT_PROFILE_NOT_FOUND" as const;
export const MCP_SERVER_NOT_FOUND = "MCP_SERVER_NOT_FOUND" as const;
export const SKILL_SOURCE_NOT_FOUND = "SKILL_SOURCE_NOT_FOUND" as const;
export const SECRET_VAULT_UNAVAILABLE = "SECRET_VAULT_UNAVAILABLE" as const;

// AgentPipeline (linear orchestration template).
export const PIPELINE_NOT_FOUND = "PIPELINE_NOT_FOUND" as const;
export const PIPELINE_INVALID_STEPS = "PIPELINE_INVALID_STEPS" as const;
export const PIPELINE_REFERENCED_PROFILE_MISSING =
  "PIPELINE_REFERENCED_PROFILE_MISSING" as const;
export const PIPELINE_IN_USE_BY_PROFILE_DELETE =
  "PIPELINE_IN_USE_BY_PROFILE_DELETE" as const;

// Remote A2A agent registry.
export const A2A_ENDPOINT_NOT_FOUND = "A2A_ENDPOINT_NOT_FOUND" as const;
