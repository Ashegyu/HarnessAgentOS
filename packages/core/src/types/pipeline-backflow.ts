import type { TaskRunStatus } from "./task-run.ts";

export type PipelineBackflowTrigger = "step_failed" | "quality_failed";

export const PIPELINE_BACKFLOW_TRIGGERS: readonly PipelineBackflowTrigger[] = [
  "step_failed",
  "quality_failed",
];

export interface AgentPipelineBackflowRule {
  id: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  instruction?: string;
}

export interface WorkerBackflowRule {
  id: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  instruction?: string;
}

export type PipelineBackflowAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "max_attempts_reached";

export const PIPELINE_BACKFLOW_ATTEMPT_STATUSES: readonly PipelineBackflowAttemptStatus[] =
  ["running", "succeeded", "failed", "max_attempts_reached"];

export type PipelineBackflowEventType =
  | "triggered"
  | "target_started"
  | "target_succeeded"
  | "retry_started"
  | "retry_succeeded"
  | "failed"
  | "max_attempts_reached";

export const PIPELINE_BACKFLOW_EVENT_TYPES: readonly PipelineBackflowEventType[] =
  [
    "triggered",
    "target_started",
    "target_succeeded",
    "retry_started",
    "retry_succeeded",
    "failed",
    "max_attempts_reached",
  ];

export interface PipelineBackflowAttempt {
  id: string;
  taskRunId: string;
  planId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  attemptIndex: number;
  status: PipelineBackflowAttemptStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreatePipelineBackflowAttemptInput {
  taskRunId: string;
  planId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  maxAttempts: number;
  status?: PipelineBackflowAttemptStatus;
  reason?: string;
}

export interface UpdatePipelineBackflowAttemptPatch {
  status?: PipelineBackflowAttemptStatus;
  reason?: string | null;
  completedAt?: string | null;
}

export interface PipelineBackflowEvent {
  id: string;
  taskRunId: string;
  threadId: string;
  threadTitle: string;
  taskRunUserRequest: string;
  taskRunStatus: TaskRunStatus;
  attemptId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
  targetStepId: string;
  retryStepId: string;
  attemptIndex: number;
  eventType: PipelineBackflowEventType;
  status: PipelineBackflowAttemptStatus;
  summary: string;
  reason?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreatePipelineBackflowEventInput {
  taskRunId: string;
  attemptId: string;
  eventType: PipelineBackflowEventType;
  status: PipelineBackflowAttemptStatus;
  summary: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface PipelineBackflowActivityInput {
  limit: number;
  offset: number;
  sinceIso?: string;
  untilIso?: string;
}

export interface PipelineBackflowActivityPage {
  items: PipelineBackflowEvent[];
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

export const isPipelineBackflowTrigger = (
  v: unknown,
): v is PipelineBackflowTrigger =>
  typeof v === "string" &&
  PIPELINE_BACKFLOW_TRIGGERS.includes(v as PipelineBackflowTrigger);

export const isAgentPipelineBackflowRule = (
  v: unknown,
): v is AgentPipelineBackflowRule => {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isPipelineBackflowTrigger(v.trigger)) return false;
  if (!isNonEmptyString(v.targetStepId)) return false;
  if (!isNonEmptyString(v.retryStepId)) return false;
  if (
    typeof v.maxAttempts !== "number" ||
    !Number.isInteger(v.maxAttempts) ||
    v.maxAttempts < 1 ||
    v.maxAttempts > 5
  ) {
    return false;
  }
  return v.instruction === undefined || typeof v.instruction === "string";
};

export const isWorkerBackflowRule = (
  v: unknown,
): v is WorkerBackflowRule => isAgentPipelineBackflowRule(v);
