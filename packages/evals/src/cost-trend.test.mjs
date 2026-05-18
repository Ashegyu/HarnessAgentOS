import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEvalCostTrend,
  evalRunRecordToCostTrendPoint,
} from "./cost-trend.ts";

const runRecord = ({
  id,
  startedAt,
  totalTokens,
  totalDurationMs,
  passedAttempts,
  attempts,
  suite = "capability",
  mode = "fake",
}) => ({
  id,
  suite,
  status: "passed",
  startedAt,
  finishedAt: startedAt,
  harnessSha: "abc123",
  createdAt: startedAt,
  summary: {
    runId: id,
    suite,
    mode,
    startedAt,
    finishedAt: startedAt,
    status: "passed",
    cases: [
      {
        case: { id: "case-1", title: "Case 1", kind: "capability" },
        attempts: Array.from({ length: attempts }, (_, idx) => ({
          attemptIdx: idx,
          passed: idx < passedAttempts,
          tokens: totalTokens / attempts,
          durationMs: totalDurationMs / attempts,
        })),
      },
    ],
  },
});

test("evalRunRecordToCostTrendPoint summarizes a run without pricing claims", () => {
  const point = evalRunRecordToCostTrendPoint(
    runRecord({
      id: "run-1",
      startedAt: "2026-05-18T00:00:00.000Z",
      totalTokens: 1200,
      totalDurationMs: 3000,
      passedAttempts: 2,
      attempts: 3,
    }),
  );

  assert.deepEqual(point, {
    runId: "run-1",
    startedAt: "2026-05-18T00:00:00.000Z",
    suite: "capability",
    mode: "fake",
    totalTokens: 1200,
    totalDurationMs: 3000,
    passRate: 2 / 3,
  });
});

test("computeEvalCostTrend returns chronological points and latest warnings", () => {
  const trend = computeEvalCostTrend(
    [
      runRecord({
        id: "run-3",
        startedAt: "2026-05-18T00:02:00.000Z",
        totalTokens: 1500,
        totalDurationMs: 2600,
        passedAttempts: 2,
        attempts: 2,
      }),
      runRecord({
        id: "run-1",
        startedAt: "2026-05-18T00:00:00.000Z",
        totalTokens: 1000,
        totalDurationMs: 2000,
        passedAttempts: 2,
        attempts: 2,
      }),
      runRecord({
        id: "run-2",
        startedAt: "2026-05-18T00:01:00.000Z",
        totalTokens: 1100,
        totalDurationMs: 2100,
        passedAttempts: 2,
        attempts: 2,
      }),
    ],
    { baselineWindow: 2 },
  );

  assert.deepEqual(
    trend.points.map((point) => point.runId),
    ["run-1", "run-2", "run-3"],
  );
  assert.equal(trend.baselineRunCount, 2);
  assert.deepEqual(
    trend.warnings.map((warning) => warning.kind),
    ["tokens_increase"],
  );
  assert.equal(trend.warnings[0].runId, "run-3");
});

test("computeEvalCostTrend warns on duration increase and pass rate drop", () => {
  const trend = computeEvalCostTrend(
    [
      runRecord({
        id: "run-1",
        startedAt: "2026-05-18T00:00:00.000Z",
        totalTokens: 1000,
        totalDurationMs: 1000,
        passedAttempts: 4,
        attempts: 4,
      }),
      runRecord({
        id: "run-2",
        startedAt: "2026-05-18T00:01:00.000Z",
        totalTokens: 1000,
        totalDurationMs: 1400,
        passedAttempts: 2,
        attempts: 4,
      }),
    ],
    { baselineWindow: 1 },
  );

  assert.deepEqual(
    trend.warnings.map((warning) => warning.kind),
    ["duration_increase", "pass_rate_drop"],
  );
});

test("computeEvalCostTrend handles empty input", () => {
  assert.deepEqual(computeEvalCostTrend([]), {
    points: [],
    warnings: [],
    baselineRunCount: 0,
  });
});
