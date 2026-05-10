import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateReward, computeReward } from "./reward-evaluator.ts";

test("computeReward returns +1 for passed gate", () => {
  const r = computeReward({
    qualityGate: {
      id: "qg_1",
      taskRunId: "tsk_1",
      status: "passed",
      knownRisks: [],
      evidenceArtifactIds: [],
      createdAt: "2024-01-01T00:00:00Z",
    },
  });
  assert.equal(r, 1);
});

test("computeReward returns -0.5 for failed gate", () => {
  const r = computeReward({
    qualityGate: {
      id: "qg_1",
      taskRunId: "tsk_1",
      status: "failed",
      knownRisks: [],
      evidenceArtifactIds: [],
      createdAt: "2024-01-01T00:00:00Z",
    },
  });
  assert.equal(r, -0.5);
});

test("computeReward applies latency penalty above 2 minutes", () => {
  const r = computeReward({
    qualityGate: {
      id: "qg_1",
      taskRunId: "tsk_1",
      status: "passed",
      knownRisks: [],
      evidenceArtifactIds: [],
      createdAt: "2024-01-01T00:00:00Z",
    },
    latencyMs: 200_000,
  });
  assert.ok(r < 1);
  assert.ok(r >= 0.5);
});

test("computeReward floors at -0.5 on explicit failure", () => {
  const r = computeReward({ success: false });
  assert.equal(r, -0.5);
});

test("aggregateReward averages numeric rewards only", () => {
  const r = aggregateReward([
    {
      id: "lrn_1",
      taskRunId: "tsk_1",
      selectedCapabilities: [],
      reward: 1,
      createdAt: "x",
    },
    {
      id: "lrn_2",
      taskRunId: "tsk_2",
      selectedCapabilities: [],
      reward: -0.5,
      createdAt: "x",
    },
    {
      id: "lrn_3",
      taskRunId: "tsk_3",
      selectedCapabilities: [],
      createdAt: "x",
    },
  ]);
  assert.equal(r, 0.25);
});

test("aggregateReward returns 0 for empty input", () => {
  assert.equal(aggregateReward([]), 0);
});
