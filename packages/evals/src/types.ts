import type { QualityGateStatus } from "@harness/core";

import type { Grader } from "./grader-types.ts";

export type EvalCaseKind = "capability" | "regression" | "safety";
export type EvalProvider = "claude" | "codex";
export type EvalRunMode =
  | "fake"
  | "real"
  | "head_to_head"
  | "judge"
  | "production_latency";

export interface EvalCase {
  readonly id: string;
  readonly kind: EvalCaseKind;
  readonly title: string;
  readonly instruction: string;
  readonly scenario: string;
  readonly attempts: number;
  readonly provider?: EvalProvider;
  readonly providers?: ReadonlyArray<EvalProvider>;
  readonly profile?: {
    readonly blockedActions?: ReadonlyArray<string>;
    readonly autoApprove?: boolean;
  };
  readonly grader: Grader;
  readonly thresholds?: {
    readonly passAt3?: number;
    readonly passToThe3?: number;
    readonly safetyFailures?: 0;
  };
  readonly budgetTokens?: number;
}

export interface EvalAttemptResult {
  readonly attemptIdx: number;
  readonly passed: boolean;
  readonly tokens: number;
  readonly durationMs: number;
  readonly gateStatus: QualityGateStatus | null;
  readonly approvalsCreated: number;
  readonly approvalsManual: number;
  readonly fsEscapeDetected: boolean;
  readonly graderReason?: string;
  readonly partialPassAsFail?: boolean;
}

export interface EvalCaseResult {
  readonly case: EvalCase;
  readonly provider?: EvalProvider;
  readonly providerGroupId?: string;
  readonly attempts: ReadonlyArray<EvalAttemptResult>;
  readonly passAt1: number;
  readonly passAt3: number;
  readonly passToThe3: number;
  readonly consistency: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly outcome: "passed" | "failed" | "partial";
}

export interface EvalRunSummary {
  readonly runId: string;
  readonly suite: EvalCaseKind | "all";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly cases: ReadonlyArray<EvalCaseResult>;
  readonly status: "running" | "passed" | "failed" | "partial";
  readonly harnessRevisionSha?: string;
  readonly mode?: EvalRunMode;
  readonly budget?: EvalRunBudget;
}

export interface EvalRunBudget {
  readonly maxTokens?: number;
  readonly maxUsd?: number;
  readonly exceeded: boolean;
}

export interface EvalCostTrendPoint {
  readonly runId: string;
  readonly startedAt: string;
  readonly suite: EvalCaseKind | "all";
  readonly mode: EvalRunMode | "unknown";
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly passRate: number;
  readonly estimatedCostUsd?: number;
}

export type RuntimeLatencyKind =
  | "task_run_to_ready"
  | "approval_to_runner_finished"
  | "agent_invocation_to_first_token"
  | "agent_invocation_to_final_result"
  | "quality_evaluation_to_gate";

export interface RuntimeLatencySummary {
  readonly kind: RuntimeLatencyKind;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number;
}
