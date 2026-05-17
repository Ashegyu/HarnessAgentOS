import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITY_THRESHOLD,
  REGRESSION_THRESHOLD,
  SAFETY_THRESHOLD,
  evaluateThresholds,
} from "./thresholds.ts";

const makeCase = (id, kind, patch = {}) => ({
  case: {
    id,
    kind,
    title: id,
    instruction: "do it",
    scenario: "ok-answer-only",
    attempts: 3,
    grader: {
      kind: "code",
      assertion: { type: "recorded_request_contains", needle: "do it" },
    },
  },
  attempts: [
    {
      attemptIdx: 0,
      passed: true,
      tokens: 1,
      durationMs: 1,
      gateStatus: "passed",
      approvalsCreated: 0,
      approvalsManual: 0,
      fsEscapeDetected: false,
    },
  ],
  passAt1: 1,
  passAt3: 1,
  passToThe3: 1,
  consistency: 1,
  totalTokens: 1,
  totalDurationMs: 1,
  outcome: "passed",
  ...patch,
});

test("CAPABILITY_THRESHOLD passes when pass@3 avg is at least 90%", () => {
  const result = CAPABILITY_THRESHOLD.check([
    makeCase("cap-a", "capability", { passAt3: 1 }),
    makeCase("cap-b", "capability", { passAt3: 1 }),
    makeCase("cap-c", "capability", { passAt3: 0.7 }),
  ]);

  assert.equal(result.passed, true);
  assert.match(result.reason, />= 90%/);
});

test("CAPABILITY_THRESHOLD fails empty capability suites", () => {
  const result = CAPABILITY_THRESHOLD.check([]);

  assert.equal(result.passed, false);
  assert.match(result.reason, /no capability cases/);
});

test("REGRESSION_THRESHOLD fails if any case has pass^3 below 100%", () => {
  const result = REGRESSION_THRESHOLD.check([
    makeCase("reg-a", "regression", { passToThe3: 1 }),
    makeCase("reg-b", "regression", { passToThe3: 0 }),
  ]);

  assert.equal(result.passed, false);
  assert.match(result.reason, /regression FAIL: reg-b/);
});

test("SAFETY_THRESHOLD fails on partialPassAsFail in any attempt", () => {
  const result = SAFETY_THRESHOLD.check([
    makeCase("safety-a", "safety", {
      attempts: [
        {
          attemptIdx: 0,
          passed: true,
          tokens: 1,
          durationMs: 1,
          gateStatus: null,
          approvalsCreated: 1,
          approvalsManual: 0,
          fsEscapeDetected: false,
          partialPassAsFail: true,
        },
      ],
    }),
  ]);

  assert.equal(result.passed, false);
  assert.match(result.reason, /safety FAIL: safety-a/);
});

test("evaluateThresholds scopes checks to the requested suite", () => {
  const results = evaluateThresholds("capability", [
    makeCase("cap-a", "capability"),
    makeCase("reg-a", "regression", { passToThe3: 0 }),
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0].suite, "capability");
  assert.equal(results[0].passed, true);
});
