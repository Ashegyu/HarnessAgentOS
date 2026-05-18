import type { EvalCaseKind, EvalCaseResult, EvalRunSummary } from "./types.ts";
import {
  collectPerformanceNotes,
  computePerformanceSummary,
  type EvalPerformanceNote,
} from "./performance-summary.ts";

interface SuiteSummary {
  readonly suite: EvalCaseKind;
  readonly total: number;
  readonly passed: number;
  readonly passAt3Avg: number;
  readonly passToThe3Avg: number | null;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
}

interface ProviderComparisonRow {
  readonly caseId: string;
  readonly provider: string;
  readonly attempts: number;
  readonly passAt3: number;
  readonly passToThe3: number | null;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly avgTokens: number;
  readonly tokensPerPassedAttempt: number | null;
}

const PASS_TO_THE_3_ATTEMPTS = 3;

export const renderReport = (summary: EvalRunSummary): string => {
  const lines: string[] = [];
  lines.push(`# Eval Report - ${summary.suite}`);
  lines.push("");
  lines.push(`- Run ID: \`${summary.runId}\``);
  lines.push(`- Started: ${summary.startedAt}`);
  lines.push(`- Finished: ${summary.finishedAt ?? "(running)"}`);
  lines.push(`- Harness SHA: \`${summary.harnessRevisionSha ?? "(unknown)"}\``);
  lines.push(`- Overall: **${summary.status.toUpperCase()}**`);
  lines.push("");
  lines.push("## Summary by Suite");
  lines.push("");
  lines.push("| Suite | Cases | Pass@3 | Pass^3 | Total Tokens | Total Time |");
  lines.push("|-------|-------|--------|--------|--------------|------------|");

  for (const suite of groupBySuite(summary.cases)) {
    lines.push(
      `| ${suite.suite} | ${suite.passed}/${suite.total} | ${pct(
        suite.passAt3Avg,
      )} | ${formatOptionalPct(suite.passToThe3Avg)} | ${formatNumber(
        suite.totalTokens,
      )} | ${formatDuration(suite.totalDurationMs)} |`,
    );
  }

  lines.push("");
  lines.push("## Performance Summary");
  lines.push("");
  lines.push(
    "| Suite | Attempts | Avg Time | P50 Time | P95 Time | Avg Tokens | Tokens/Passed Attempt | Approvals Created | Manual Approvals | Attempt Pass Rate |",
  );
  lines.push(
    "|-------|----------|----------|----------|----------|------------|-----------------------|-------------------|------------------|-------------------|",
  );

  for (const suite of computePerformanceSummary(summary.cases)) {
    lines.push(
      `| ${suite.suite} | ${formatNumber(suite.attemptCount)} | ${formatDuration(
        suite.avgDurationMs,
      )} | ${formatDuration(suite.p50DurationMs)} | ${formatDuration(
        suite.p95DurationMs,
      )} | ${formatNumber(suite.avgTokens)} | ${formatOptionalNumber(
        suite.tokensPerPassedAttempt,
      )} | ${formatNumber(suite.totalApprovalsCreated)} | ${formatNumber(
        suite.totalApprovalsManual,
      )} | ${pct(suite.passRate)} |`,
    );
  }

  const providerRows = providerComparisonRows(summary.cases);
  if (providerRows.length > 0) {
    lines.push("");
    lines.push("## Provider Comparison");
    lines.push("");
    lines.push(
      "| Case | Provider | Attempts | Pass@3 | Pass^3 | Avg Time | P95 Time | Avg Tokens | Tokens/Passed |",
    );
    lines.push(
      "|------|----------|----------|--------|--------|----------|----------|------------|---------------|",
    );

    for (const row of providerRows) {
      lines.push(
        `| ${row.caseId} | ${row.provider} | ${formatNumber(
          row.attempts,
        )} | ${pct(row.passAt3)} | ${formatOptionalPct(
          row.passToThe3,
        )} | ${formatDuration(row.avgDurationMs)} | ${formatDuration(
          row.p95DurationMs,
        )} | ${formatNumber(row.avgTokens)} | ${formatOptionalNumber(
          row.tokensPerPassedAttempt,
        )} |`,
      );
    }
  }

  const performanceNotes = collectPerformanceNotes(summary.cases);
  if (performanceNotes.length > 0) {
    lines.push("");
    lines.push("## Performance Notes");
    lines.push("");
    lines.push("| Suite | Case | Attempt | Signal | Observed | Threshold |");
    lines.push("|-------|------|---------|--------|----------|-----------|");
    for (const note of performanceNotes) {
      lines.push(
        `| ${note.suite} | ${note.caseId} | ${note.attemptIdx} | ${performanceNoteLabel(
          note,
        )} | ${formatPerformanceNoteValue(note, note.observed)} | ${formatPerformanceNoteValue(
          note,
          note.threshold,
        )} |`,
      );
    }
  }

  lines.push("");

  for (const caseResult of summary.cases) {
    lines.push(...renderCaseResult(caseResult));
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

const renderCaseResult = (caseResult: EvalCaseResult): string[] => {
  const lines: string[] = [];
  lines.push(
    `### \`${caseResult.case.id}\` - ${caseResult.case.kind}${
      caseResult.provider ? ` - ${caseResult.provider}` : ""
    }`,
  );
  lines.push("");
  lines.push(`> ${caseResult.case.title}`);
  lines.push("");
  lines.push(
    `Pass@1: ${pct(caseResult.passAt1)} | Pass@3: ${pct(
      caseResult.passAt3,
    )} | Pass^3: ${formatPassToThe3(caseResult)} | Consistency: ${pct(
      caseResult.consistency,
    )}`,
  );
  lines.push("");
  lines.push("| Attempt | Passed | Tokens | Time | Gate | FS Escape | Partial |");
  lines.push("|---------|--------|--------|------|------|-----------|---------|");

  for (const attempt of caseResult.attempts) {
    lines.push(
      `| ${attempt.attemptIdx} | ${attempt.passed ? "PASS" : "FAIL"} | ${formatNumber(
        attempt.tokens,
      )} | ${formatDuration(attempt.durationMs)} | ${attempt.gateStatus ?? "-"} | ${
        attempt.fsEscapeDetected ? "YES" : "-"
      } | ${attempt.partialPassAsFail ? "YES" : "-"} |`,
    );
  }

  const failedAttempts = caseResult.attempts.filter(
    (attempt) => attempt.graderReason !== undefined,
  );
  if (failedAttempts.length > 0) {
    lines.push("");
    lines.push("**Failure reasons**");
    for (const attempt of failedAttempts) {
      lines.push(`- attempt-${attempt.attemptIdx}: ${attempt.graderReason}`);
    }
  }

  lines.push("");
  return lines;
};

const groupBySuite = (
  cases: ReadonlyArray<EvalCaseResult>,
): ReadonlyArray<SuiteSummary> => {
  const bySuite = new Map<EvalCaseKind, EvalCaseResult[]>();
  for (const caseResult of cases) {
    bySuite.set(caseResult.case.kind, [
      ...(bySuite.get(caseResult.case.kind) ?? []),
      caseResult,
    ]);
  }

  return Array.from(bySuite.entries()).map(([suite, suiteCases]) => {
    const total = suiteCases.length;
    const totalTokens = suiteCases.reduce(
      (sum, caseResult) => sum + caseResult.totalTokens,
      0,
    );
    const totalDurationMs = suiteCases.reduce(
      (sum, caseResult) => sum + caseResult.totalDurationMs,
      0,
    );
    const passAt3Total = suiteCases.reduce(
      (sum, caseResult) => sum + caseResult.passAt3,
      0,
    );
    const passToThe3Cases = suiteCases.filter(hasPassToThe3Coverage);
    const passToThe3Total = passToThe3Cases.reduce(
      (sum, caseResult) => sum + caseResult.passToThe3,
      0,
    );
    return {
      suite,
      total,
      passed: suiteCases.filter((caseResult) => caseResult.outcome === "passed")
        .length,
      passAt3Avg: total === 0 ? 0 : passAt3Total / total,
      passToThe3Avg:
        passToThe3Cases.length === 0
          ? null
          : passToThe3Total / passToThe3Cases.length,
      totalTokens,
      totalDurationMs,
    };
  });
};

const providerComparisonRows = (
  cases: ReadonlyArray<EvalCaseResult>,
): ReadonlyArray<ProviderComparisonRow> =>
  cases
    .filter(
      (caseResult): caseResult is EvalCaseResult & { provider: string } =>
        caseResult.provider !== undefined,
    )
    .map((caseResult) => {
      const attemptCount = caseResult.attempts.length;
      const passedAttempts = caseResult.attempts.filter(
        (attempt) => attempt.passed,
      ).length;
      const durations = caseResult.attempts
        .map((attempt) => attempt.durationMs)
        .sort((left, right) => left - right);
      return {
        caseId: caseResult.providerGroupId ?? caseResult.case.id,
        provider: caseResult.provider,
        attempts: attemptCount,
        passAt3: caseResult.passAt3,
        passToThe3: hasPassToThe3Coverage(caseResult)
          ? caseResult.passToThe3
          : null,
        avgDurationMs:
          attemptCount === 0
            ? 0
            : caseResult.totalDurationMs / attemptCount,
        p95DurationMs: percentileNearestRank(durations, 95),
        avgTokens:
          attemptCount === 0 ? 0 : caseResult.totalTokens / attemptCount,
        tokensPerPassedAttempt:
          passedAttempts === 0 ? null : caseResult.totalTokens / passedAttempts,
      };
    });

const pct = (value: number): string => `${Math.round(value * 100)}%`;

const formatOptionalPct = (value: number | null): string =>
  value === null ? "n/a" : pct(value);

const hasPassToThe3Coverage = (caseResult: EvalCaseResult): boolean =>
  caseResult.case.attempts >= PASS_TO_THE_3_ATTEMPTS;

const formatPassToThe3 = (caseResult: EvalCaseResult): string =>
  hasPassToThe3Coverage(caseResult) ? pct(caseResult.passToThe3) : "n/a";

const formatDuration = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) {
    return "n/a";
  }
  if (value === 0) {
    return "<1ms";
  }
  if (value < 1000) {
    return `${Math.round(value).toLocaleString("en-US")}ms`;
  }
  return `${(value / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}s`;
};

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 1,
  });
};

const formatOptionalNumber = (value: number | null): string =>
  value === null ? "n/a" : formatNumber(value);

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

const performanceNoteLabel = (note: EvalPerformanceNote): string => {
  switch (note.kind) {
    case "high_tokens":
      return "High tokens";
    case "slow_attempt":
      return "Slow attempt";
  }
};

const formatPerformanceNoteValue = (
  note: EvalPerformanceNote,
  value: number,
): string => {
  switch (note.kind) {
    case "high_tokens":
      return `${formatNumber(value)} tokens`;
    case "slow_attempt":
      return formatDuration(value);
  }
};
