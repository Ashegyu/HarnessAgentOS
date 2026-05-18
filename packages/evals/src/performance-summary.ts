import type {
  EvalAttemptResult,
  EvalCaseKind,
  EvalCaseResult,
} from "./types.ts";

export interface EvalPerformanceSuiteSummary {
  readonly suite: EvalCaseKind;
  readonly attemptCount: number;
  readonly avgDurationMs: number;
  readonly p50DurationMs: number;
  readonly p95DurationMs: number;
  readonly avgTokens: number;
  readonly tokensPerPassedAttempt: number | null;
  readonly totalApprovalsCreated: number;
  readonly totalApprovalsManual: number;
  readonly passRate: number;
}

export type EvalPerformanceNoteKind = "high_tokens" | "slow_attempt";

export interface EvalPerformanceNote {
  readonly kind: EvalPerformanceNoteKind;
  readonly suite: EvalCaseKind;
  readonly caseId: string;
  readonly attemptIdx: number;
  readonly observed: number;
  readonly threshold: number;
}

export interface EvalPerformanceNoteThresholds {
  readonly highTokenThreshold: number;
  readonly slowAttemptThresholdMs: number;
}

export const DEFAULT_PERFORMANCE_NOTE_THRESHOLDS: EvalPerformanceNoteThresholds =
  {
    highTokenThreshold: 50_000,
    slowAttemptThresholdMs: 30_000,
  };

export const computePerformanceSummary = (
  cases: ReadonlyArray<EvalCaseResult>,
): ReadonlyArray<EvalPerformanceSuiteSummary> => {
  const bySuite = new Map<EvalCaseKind, EvalAttemptResult[]>();

  for (const caseResult of cases) {
    const suiteAttempts = bySuite.get(caseResult.case.kind);
    if (suiteAttempts) {
      suiteAttempts.push(...caseResult.attempts);
      continue;
    }
    bySuite.set(caseResult.case.kind, [...caseResult.attempts]);
  }

  return Array.from(bySuite.entries()).map(([suite, attempts]) =>
    summarizeSuite(suite, attempts),
  );
};

export const collectPerformanceNotes = (
  cases: ReadonlyArray<EvalCaseResult>,
  thresholds: EvalPerformanceNoteThresholds = DEFAULT_PERFORMANCE_NOTE_THRESHOLDS,
): ReadonlyArray<EvalPerformanceNote> => {
  const notes: EvalPerformanceNote[] = [];

  for (const caseResult of cases) {
    for (const attempt of caseResult.attempts) {
      if (attempt.tokens >= thresholds.highTokenThreshold) {
        notes.push({
          kind: "high_tokens",
          suite: caseResult.case.kind,
          caseId: caseResult.case.id,
          attemptIdx: attempt.attemptIdx,
          observed: attempt.tokens,
          threshold: thresholds.highTokenThreshold,
        });
      }

      if (attempt.durationMs >= thresholds.slowAttemptThresholdMs) {
        notes.push({
          kind: "slow_attempt",
          suite: caseResult.case.kind,
          caseId: caseResult.case.id,
          attemptIdx: attempt.attemptIdx,
          observed: attempt.durationMs,
          threshold: thresholds.slowAttemptThresholdMs,
        });
      }
    }
  }

  return notes;
};

const summarizeSuite = (
  suite: EvalCaseKind,
  attempts: ReadonlyArray<EvalAttemptResult>,
): EvalPerformanceSuiteSummary => {
  const attemptCount = attempts.length;
  const totalDurationMs = attempts.reduce(
    (sum, attempt) => sum + attempt.durationMs,
    0,
  );
  const totalTokens = attempts.reduce((sum, attempt) => sum + attempt.tokens, 0);
  const passedAttempts = attempts.filter((attempt) => attempt.passed).length;
  const totalApprovalsCreated = attempts.reduce(
    (sum, attempt) => sum + attempt.approvalsCreated,
    0,
  );
  const totalApprovalsManual = attempts.reduce(
    (sum, attempt) => sum + attempt.approvalsManual,
    0,
  );
  const durations = attempts
    .map((attempt) => attempt.durationMs)
    .sort((left, right) => left - right);

  return {
    suite,
    attemptCount,
    avgDurationMs: attemptCount === 0 ? 0 : totalDurationMs / attemptCount,
    p50DurationMs: percentileNearestRank(durations, 50),
    p95DurationMs: percentileNearestRank(durations, 95),
    avgTokens: attemptCount === 0 ? 0 : totalTokens / attemptCount,
    tokensPerPassedAttempt:
      passedAttempts === 0 ? null : totalTokens / passedAttempts,
    totalApprovalsCreated,
    totalApprovalsManual,
    passRate: attemptCount === 0 ? 0 : passedAttempts / attemptCount,
  };
};

const percentileNearestRank = (
  sortedValues: ReadonlyArray<number>,
  percentile: number,
): number => {
  if (sortedValues.length === 0) {
    return 0;
  }

  const rawIndex = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const index = Math.max(0, Math.min(sortedValues.length - 1, rawIndex));
  return sortedValues[index] ?? 0;
};
