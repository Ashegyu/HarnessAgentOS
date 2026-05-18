import type {
  EvalRunCaseView,
  EvalRunDetailView,
  EvalRunListItem,
} from "@harness/core";
import type { EvalRunRecord } from "@harness/storage";

interface EvalAttemptLike {
  readonly passed?: boolean;
  readonly tokens?: number;
  readonly durationMs?: number;
}

interface EvalCaseResultLike {
  readonly case?: {
    readonly id?: string;
    readonly title?: string;
    readonly kind?: "capability" | "regression" | "safety";
  };
  readonly provider?: "claude" | "codex";
  readonly attempts?: ReadonlyArray<EvalAttemptLike>;
  readonly passAt3?: number;
  readonly passToThe3?: number;
  readonly totalTokens?: number;
  readonly totalDurationMs?: number;
  readonly outcome?: "passed" | "failed" | "partial";
}

export const evalRunRecordToListItem = (
  record: EvalRunRecord,
): EvalRunListItem => {
  const cases = caseResults(record);
  const attemptCount = cases.reduce(
    (sum, caseResult) => sum + attempts(caseResult).length,
    0,
  );
  const passedAttempts = cases.reduce(
    (sum, caseResult) =>
      sum +
      attempts(caseResult).filter((attempt) => attempt.passed === true).length,
    0,
  );

  return {
    id: record.id,
    suite: record.suite,
    status: record.status,
    ...(typeof record.summary.mode === "string"
      ? { mode: record.summary.mode }
      : {}),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    harnessSha: record.harnessSha,
    caseCount: cases.length,
    attemptCount,
    passedAttempts,
    passRate: attemptCount === 0 ? 0 : passedAttempts / attemptCount,
    totalTokens: cases.reduce(
      (sum, caseResult) => sum + totalTokens(caseResult),
      0,
    ),
    totalDurationMs: cases.reduce(
      (sum, caseResult) => sum + totalDurationMs(caseResult),
      0,
    ),
  };
};

export const evalRunRecordToDetail = (
  record: EvalRunRecord,
): EvalRunDetailView => ({
  run: evalRunRecordToListItem(record),
  cases: caseResults(record).map((caseResult) => {
    const caseAttempts = attempts(caseResult);
    return {
      caseId: caseResult.case?.id ?? "(unknown)",
      title: caseResult.case?.title ?? "",
      suite: caseResult.case?.kind ?? "capability",
      ...(caseResult.provider ? { provider: caseResult.provider } : {}),
      outcome: caseResult.outcome ?? "failed",
      attemptCount: caseAttempts.length,
      passedAttempts: caseAttempts.filter((attempt) => attempt.passed === true)
        .length,
      passAt3: finiteNumber(caseResult.passAt3),
      passToThe3: finiteNumber(caseResult.passToThe3),
      totalTokens: totalTokens(caseResult),
      totalDurationMs: totalDurationMs(caseResult),
    };
  }),
});

const caseResults = (record: EvalRunRecord): ReadonlyArray<EvalCaseResultLike> =>
  Array.isArray(record.summary.cases)
    ? (record.summary.cases as ReadonlyArray<EvalCaseResultLike>)
    : [];

const attempts = (
  caseResult: EvalCaseResultLike,
): ReadonlyArray<EvalAttemptLike> =>
  Array.isArray(caseResult.attempts) ? caseResult.attempts : [];

const totalTokens = (caseResult: EvalCaseResultLike): number => {
  if (Number.isFinite(caseResult.totalTokens)) {
    return caseResult.totalTokens ?? 0;
  }
  return attempts(caseResult).reduce(
    (sum, attempt) => sum + finiteNumber(attempt.tokens),
    0,
  );
};

const totalDurationMs = (caseResult: EvalCaseResultLike): number => {
  if (Number.isFinite(caseResult.totalDurationMs)) {
    return caseResult.totalDurationMs ?? 0;
  }
  return attempts(caseResult).reduce(
    (sum, attempt) => sum + finiteNumber(attempt.durationMs),
    0,
  );
};

const finiteNumber = (value: number | undefined): number =>
  Number.isFinite(value) ? (value ?? 0) : 0;
