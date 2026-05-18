import { test } from "node:test";
import assert from "node:assert/strict";

import { computePerformanceSummary } from "./performance-summary.ts";

const mkAttempt = ({
  attemptIdx = 0,
  passed = true,
  tokens = 100,
  durationMs = 100,
  approvalsCreated = 0,
  approvalsManual = 0,
} = {}) => ({
  attemptIdx,
  passed,
  tokens,
  durationMs,
  gateStatus: passed ? "passed" : "failed",
  approvalsCreated,
  approvalsManual,
  fsEscapeDetected: false,
});

const mkCase = (id, kind, attempts) => ({
  case: {
    id,
    kind,
    title: id,
    instruction: "do it",
    scenario: "ok-answer-only",
    attempts: attempts.length,
    grader: {
      kind: "code",
      assertion: {
        type: "recorded_request_contains",
        needle: "do it",
      },
    },
  },
  attempts,
  passAt1: attempts[0]?.passed ? 1 : 0,
  passAt3: attempts.slice(0, 3).some((attempt) => attempt.passed) ? 1 : 0,
  passToThe3:
    attempts.length >= 3 && attempts.slice(0, 3).every((attempt) => attempt.passed)
      ? 1
      : 0,
  consistency:
    attempts.length === 0
      ? 0
      : attempts.filter((attempt) => attempt.passed).length / attempts.length,
  totalTokens: attempts.reduce((sum, attempt) => sum + attempt.tokens, 0),
  totalDurationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
  outcome: attempts.every((attempt) => attempt.passed) ? "passed" : "failed",
});

test("computePerformanceSummary calculates averages and duration percentiles", () => {
  const [summary] = computePerformanceSummary([
    mkCase("cap-a", "capability", [
      mkAttempt({
        attemptIdx: 0,
        passed: true,
        tokens: 1_000,
        durationMs: 100,
        approvalsCreated: 1,
      }),
      mkAttempt({
        attemptIdx: 1,
        passed: false,
        tokens: 3_000,
        durationMs: 200,
        approvalsCreated: 2,
        approvalsManual: 1,
      }),
      mkAttempt({
        attemptIdx: 2,
        passed: true,
        tokens: 5_000,
        durationMs: 300,
      }),
      mkAttempt({
        attemptIdx: 3,
        passed: false,
        tokens: 7_000,
        durationMs: 400,
        approvalsCreated: 1,
        approvalsManual: 1,
      }),
      mkAttempt({
        attemptIdx: 4,
        passed: true,
        tokens: 9_000,
        durationMs: 500,
      }),
    ]),
  ]);

  assert.equal(summary.suite, "capability");
  assert.equal(summary.attemptCount, 5);
  assert.equal(summary.avgDurationMs, 300);
  assert.equal(summary.p50DurationMs, 300);
  assert.equal(summary.p95DurationMs, 500);
  assert.equal(summary.avgTokens, 5_000);
  assert.equal(summary.tokensPerPassedAttempt, 25_000 / 3);
  assert.equal(summary.totalApprovalsCreated, 4);
  assert.equal(summary.totalApprovalsManual, 2);
  assert.equal(summary.passRate, 3 / 5);
});

test("computePerformanceSummary returns null tokensPerPassedAttempt when no attempt passed", () => {
  const [summary] = computePerformanceSummary([
    mkCase("reg-a", "regression", [
      mkAttempt({ attemptIdx: 0, passed: false, tokens: 200 }),
      mkAttempt({ attemptIdx: 1, passed: false, tokens: 300 }),
    ]),
  ]);

  assert.equal(summary.attemptCount, 2);
  assert.equal(summary.passRate, 0);
  assert.equal(summary.tokensPerPassedAttempt, null);
});

test("computePerformanceSummary groups attempts by suite", () => {
  const summaries = computePerformanceSummary([
    mkCase("cap-a", "capability", [
      mkAttempt({ attemptIdx: 0, tokens: 100, durationMs: 20 }),
    ]),
    mkCase("safety-a", "safety", [
      mkAttempt({ attemptIdx: 0, tokens: 200, durationMs: 40 }),
      mkAttempt({ attemptIdx: 1, passed: false, tokens: 400, durationMs: 80 }),
    ]),
  ]);

  assert.deepEqual(
    summaries.map((summary) => ({
      suite: summary.suite,
      attemptCount: summary.attemptCount,
      avgTokens: summary.avgTokens,
      p95DurationMs: summary.p95DurationMs,
    })),
    [
      {
        suite: "capability",
        attemptCount: 1,
        avgTokens: 100,
        p95DurationMs: 20,
      },
      {
        suite: "safety",
        attemptCount: 2,
        avgTokens: 300,
        p95DurationMs: 80,
      },
    ],
  );
});

test("computePerformanceSummary returns no rows for empty input", () => {
  assert.deepEqual(computePerformanceSummary([]), []);
});
