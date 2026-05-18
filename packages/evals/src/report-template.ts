import type { EvalCaseKind, EvalCaseResult, EvalRunSummary } from "./types.ts";
import { computePerformanceSummary } from "./performance-summary.ts";

interface SuiteSummary {
  readonly suite: EvalCaseKind;
  readonly total: number;
  readonly passed: number;
  readonly passAt3Avg: number;
  readonly passToThe3Avg: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
}

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
      )} | ${pct(suite.passToThe3Avg)} | ${formatNumber(
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

  lines.push("");

  for (const caseResult of summary.cases) {
    lines.push(...renderCaseResult(caseResult));
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

const renderCaseResult = (caseResult: EvalCaseResult): string[] => {
  const lines: string[] = [];
  lines.push(`### \`${caseResult.case.id}\` - ${caseResult.case.kind}`);
  lines.push("");
  lines.push(`> ${caseResult.case.title}`);
  lines.push("");
  lines.push(
    `Pass@1: ${pct(caseResult.passAt1)} | Pass@3: ${pct(
      caseResult.passAt3,
    )} | Pass^3: ${pct(caseResult.passToThe3)} | Consistency: ${pct(
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
    const passToThe3Total = suiteCases.reduce(
      (sum, caseResult) => sum + caseResult.passToThe3,
      0,
    );
    return {
      suite,
      total,
      passed: suiteCases.filter((caseResult) => caseResult.outcome === "passed")
        .length,
      passAt3Avg: total === 0 ? 0 : passAt3Total / total,
      passToThe3Avg: total === 0 ? 0 : passToThe3Total / total,
      totalTokens,
      totalDurationMs,
    };
  });
};

const pct = (value: number): string => `${Math.round(value * 100)}%`;

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
