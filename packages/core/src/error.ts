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
export const CAPABILITY_NOT_FOUND = "CAPABILITY_NOT_FOUND" as const;
export const CAPABILITY_UNTRUSTED_SCRIPT =
  "CAPABILITY_UNTRUSTED_SCRIPT" as const;
export const CAPABILITY_REFRESH_FAILED = "CAPABILITY_REFRESH_FAILED" as const;
export const CAPABILITY_SCRIPT_TRAVERSAL =
  "CAPABILITY_SCRIPT_TRAVERSAL" as const;

// Phase 6 - learner namespace
export const LEARNER_TASK_NOT_FOUND = "LEARNER_TASK_NOT_FOUND" as const;
export const LEARNER_TRACE_NOT_FOUND = "LEARNER_TRACE_NOT_FOUND" as const;
export const LEARNER_DECISION_INVALID = "LEARNER_DECISION_INVALID" as const;

// Phase 7 - orchestration namespace
export const ORCH_TASK_NOT_FOUND = "ORCH_TASK_NOT_FOUND" as const;
export const ORCH_INVALID_PLAN = "ORCH_INVALID_PLAN" as const;
export const ORCH_APPROVAL_NOT_APPROVED = "ORCH_APPROVAL_NOT_APPROVED" as const;
export const ORCH_APPROVAL_TYPE_MISMATCH =
  "ORCH_APPROVAL_TYPE_MISMATCH" as const;
export const ORCH_DIRECT_ACTION_BLOCKED =
  "ORCH_DIRECT_ACTION_BLOCKED" as const;
export const ORCH_PLAN_NOT_FOUND = "ORCH_PLAN_NOT_FOUND" as const;
