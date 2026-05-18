export type EvalRunSuite = "capability" | "regression" | "safety" | "all";
export type EvalRunStatus = "running" | "passed" | "failed" | "partial";
export type EvalRunMode =
  | "fake"
  | "real"
  | "head_to_head"
  | "judge"
  | "production_latency"
  | "unknown";

export interface EvalRunListFilters {
  readonly suite?: EvalRunSuite;
  readonly status?: EvalRunStatus;
  readonly limit?: number;
}

export interface EvalRunListItem {
  readonly id: string;
  readonly suite: EvalRunSuite;
  readonly status: EvalRunStatus;
  readonly mode?: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly harnessSha: string | null;
  readonly caseCount: number;
  readonly attemptCount: number;
  readonly passedAttempts: number;
  readonly passRate: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
}

export interface EvalRunCaseView {
  readonly caseId: string;
  readonly title: string;
  readonly suite: Exclude<EvalRunSuite, "all">;
  readonly provider?: "claude" | "codex";
  readonly outcome: "passed" | "failed" | "partial";
  readonly attemptCount: number;
  readonly passedAttempts: number;
  readonly passAt3: number;
  readonly passToThe3: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
}

export interface EvalRunDetailView {
  readonly run: EvalRunListItem;
  readonly cases: ReadonlyArray<EvalRunCaseView>;
}

export interface EvalCostTrendFilters {
  readonly suite?: EvalRunSuite;
  readonly limit?: number;
  readonly baselineWindow?: number;
}

export interface EvalCostTrendPoint {
  readonly runId: string;
  readonly startedAt: string;
  readonly suite: EvalRunSuite;
  readonly mode: EvalRunMode;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly passRate: number;
  readonly estimatedCostUsd?: number;
}

export type EvalCostTrendWarningKind =
  | "tokens_increase"
  | "duration_increase"
  | "pass_rate_drop";

export interface EvalCostTrendWarning {
  readonly kind: EvalCostTrendWarningKind;
  readonly runId: string;
  readonly observed: number;
  readonly baseline: number;
  readonly threshold: number;
  readonly message: string;
}

export interface EvalCostTrendView {
  readonly points: ReadonlyArray<EvalCostTrendPoint>;
  readonly warnings: ReadonlyArray<EvalCostTrendWarning>;
  readonly baselineRunCount: number;
}

export type RuntimeLatencyKind =
  | "task_run_to_ready"
  | "approval_to_runner_finished"
  | "agent_invocation_to_first_token"
  | "agent_invocation_to_final_result"
  | "quality_evaluation_to_gate";

export interface RuntimeLatencyFilters {
  readonly limit?: number;
}

export interface RuntimeLatencySummary {
  readonly kind: RuntimeLatencyKind;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number;
}
