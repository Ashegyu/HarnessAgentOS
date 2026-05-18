import test from "node:test";
import assert from "node:assert/strict";

import { computeRuntimeLatencySummaries } from "./production-latency.ts";

const samples = (count, base = 10, kind = "agent_invocation_to_final_result") =>
  Array.from({ length: count }, (_, index) => ({
    kind,
    durationMs: base + index,
    success: true,
  }));

test("computeRuntimeLatencySummaries calculates p50 and gates p95/p99 by sample count", () => {
  const [summary] = computeRuntimeLatencySummaries(samples(19));

  assert.equal(summary.kind, "agent_invocation_to_final_result");
  assert.equal(summary.count, 19);
  assert.equal(summary.p50Ms, 19);
  assert.equal(summary.p95Ms, null);
  assert.equal(summary.p99Ms, null);
  assert.equal(summary.maxMs, 28);
});

test("computeRuntimeLatencySummaries exposes p95 at 20 samples and p99 at 100 samples", () => {
  const [p95Summary] = computeRuntimeLatencySummaries(samples(20));
  const [p99Summary] = computeRuntimeLatencySummaries(samples(100));

  assert.equal(p95Summary.p95Ms, 28);
  assert.equal(p95Summary.p99Ms, null);
  assert.equal(p99Summary.p95Ms, 104);
  assert.equal(p99Summary.p99Ms, 108);
});

test("computeRuntimeLatencySummaries groups by latency kind", () => {
  const summaries = computeRuntimeLatencySummaries([
    ...samples(20, 10, "agent_invocation_to_final_result"),
    ...samples(20, 100, "quality_evaluation_to_gate"),
  ]);

  assert.deepEqual(
    summaries.map((summary) => summary.kind),
    ["agent_invocation_to_final_result", "quality_evaluation_to_gate"],
  );
  assert.equal(summaries[1].p50Ms, 109.5);
});

test("computeRuntimeLatencySummaries ignores invalid durations", () => {
  const summaries = computeRuntimeLatencySummaries([
    { kind: "agent_invocation_to_final_result", durationMs: 10, success: true },
    { kind: "agent_invocation_to_final_result", durationMs: NaN, success: true },
    { kind: "agent_invocation_to_final_result", durationMs: -1, success: true },
  ]);

  assert.deepEqual(summaries, [
    {
      kind: "agent_invocation_to_final_result",
      count: 1,
      p50Ms: 10,
      p95Ms: null,
      p99Ms: null,
      maxMs: 10,
    },
  ]);
});

test("computeRuntimeLatencySummaries handles empty input", () => {
  assert.deepEqual(computeRuntimeLatencySummaries([]), []);
});
