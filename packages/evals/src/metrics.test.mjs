import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeConsistency,
  computePassAt1,
  computePassAtK,
  computePassToTheK,
} from "./metrics.ts";

const mkAttempt = (attemptIdx, passed) => ({
  attemptIdx,
  passed,
  tokens: 0,
  durationMs: 0,
  gateStatus: null,
  approvalsCreated: 0,
  approvalsManual: 0,
  fsEscapeDetected: false,
});

test("computePassAt1 returns 1 when first attempt passes", () => {
  assert.equal(computePassAt1([mkAttempt(0, true), mkAttempt(1, false)]), 1);
});

test("computePassAt1 returns 0 when first attempt fails regardless of later attempts", () => {
  assert.equal(
    computePassAt1([mkAttempt(0, false), mkAttempt(1, true), mkAttempt(2, true)]),
    0,
  );
});

test("computePassAtK returns 1 when any of the first k attempts passes", () => {
  assert.equal(
    computePassAtK([mkAttempt(0, false), mkAttempt(1, false), mkAttempt(2, true)], 3),
    1,
  );
});

test("computePassAtK returns 0 when none of the first k attempts pass", () => {
  assert.equal(
    computePassAtK([mkAttempt(0, false), mkAttempt(1, false), mkAttempt(2, false)], 3),
    0,
  );
});

test("computePassToTheK returns 1 only when all first k attempts pass", () => {
  assert.equal(
    computePassToTheK([mkAttempt(0, true), mkAttempt(1, true), mkAttempt(2, true)], 3),
    1,
  );
});

test("computePassToTheK returns 0 when any of the first k attempts fails", () => {
  assert.equal(
    computePassToTheK([mkAttempt(0, true), mkAttempt(1, false), mkAttempt(2, true)], 3),
    0,
  );
});

test("computeConsistency returns pass rate across attempts", () => {
  const consistency = computeConsistency([
    mkAttempt(0, true),
    mkAttempt(1, false),
    mkAttempt(2, true),
  ]);

  assert.ok(Math.abs(consistency - 2 / 3) < 0.001);
});
