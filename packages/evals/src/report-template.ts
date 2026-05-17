import type { EvalCaseKind, EvalCaseResult, EvalRunSummary } from "./types.ts";

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
      )} | ${pct(suite.passToThe3Avg)} | ${suite.totalTokens.toLocaleString(
        "en-US",
      )} | ${ms(suite.totalDurationMs)} |`,
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
      `| ${attempt.attemptIdx} | ${attempt.passed ? "PASS" : "FAIL"} | ${attempt.tokens.toLocaleString(
        "en-US",
      )} | ${ms(attempt.durationMs)} | ${attempt.gateStatus ?? "-"} | ${
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

const ms = (value: number): string => {
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
};
