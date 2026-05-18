export type EvalRunSuite = "capability" | "regression" | "safety" | "all";
export type EvalRunStatus = "running" | "passed" | "failed" | "partial";

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
