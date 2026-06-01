import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreInstinctCandidates } from "./instinct-candidate-scorer.ts";

const observation = (overrides = {}) => ({
  id: `obs_${Math.random().toString(16).slice(2)}`,
  projectKey: "proj_a",
  source: "approval",
  eventType: "rejected",
  signal: "file_write_denied",
  summary: "User rejected a file write",
  payload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("scoreInstinctCandidates proposes a candidate after repeated signals", () => {
  const candidates = scoreInstinctCandidates({
    observations: [observation({ id: "obs_a" }), observation({ id: "obs_b" }), observation({ id: "obs_c" })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projectKey, "proj_a");
  assert.deepEqual(candidates[0].observationIds, ["obs_a", "obs_b", "obs_c"]);
  assert.equal(candidates[0].confidence, 0.5);
  assert.match(candidates[0].proposedRule, /Do not automatically retry/);
});

test("scoreInstinctCandidates does not propose below the minimum signal count", () => {
  const candidates = scoreInstinctCandidates({
    observations: [observation({ id: "obs_a" }), observation({ id: "obs_b" })],
  });
  assert.deepEqual(candidates, []);
});

test("scoreInstinctCandidates ignores repeated approval approvals", () => {
  const candidates = scoreInstinctCandidates({
    observations: [
      observation({
        id: "obs_a",
        eventType: "approved",
        signal: "file_write",
        summary: "file_write approved",
      }),
      observation({
        id: "obs_b",
        eventType: "approved",
        signal: "file_write",
        summary: "file_write approved",
      }),
      observation({
        id: "obs_c",
        eventType: "approved",
        signal: "file_write",
        summary: "file_write approved",
      }),
    ],
  });
  assert.deepEqual(candidates, []);
});

test("scoreInstinctCandidates ignores non-failing quality gates", () => {
  const candidates = scoreInstinctCandidates({
    observations: [
      observation({
        id: "obs_a",
        source: "quality",
        eventType: "passed",
        signal: "passed",
        summary: "quality gate passed",
      }),
      observation({
        id: "obs_b",
        source: "quality",
        eventType: "passed",
        signal: "passed",
        summary: "quality gate passed",
      }),
      observation({
        id: "obs_c",
        source: "quality",
        eventType: "passed",
        signal: "passed",
        summary: "quality gate passed",
      }),
    ],
  });
  assert.deepEqual(candidates, []);
});

test("scoreInstinctCandidates proposes a review candidate for repeated passed pinned context outcomes", () => {
  const candidates = scoreInstinctCandidates({
    observations: [
      observation({
        id: "obs_context",
        source: "quality",
        eventType: "failed",
        signal: "failed",
        summary: "quality failed until rebuild:node was run",
      }),
      observation({
        id: "obs_outcome_a",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "passed",
        summary: "quality gate passed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "passed",
        },
      }),
      observation({
        id: "obs_outcome_b",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "passed",
        summary: "quality gate passed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "passed",
        },
      }),
      observation({
        id: "obs_outcome_c",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "passed",
        summary: "quality gate passed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "passed",
        },
      }),
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projectKey, "proj_a");
  assert.match(candidates[0].title, /pinned context/i);
  assert.match(candidates[0].proposedRule, /surface proven context/i);
  assert.deepEqual(candidates[0].observationIds, [
    "obs_context",
    "obs_outcome_a",
    "obs_outcome_b",
    "obs_outcome_c",
  ]);
});

test("scoreInstinctCandidates does not promote failed pinned context outcomes", () => {
  const candidates = scoreInstinctCandidates({
    observations: [
      observation({
        id: "obs_outcome_a",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "failed",
        summary: "quality gate failed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "failed",
        },
      }),
      observation({
        id: "obs_outcome_b",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "failed",
        summary: "quality gate failed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "failed",
        },
      }),
      observation({
        id: "obs_outcome_c",
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: "failed",
        summary: "quality gate failed after 1 pinned observations",
        payload: {
          pinnedObservationIds: ["obs_context"],
          qualityStatus: "failed",
        },
      }),
    ],
  });

  assert.deepEqual(candidates, []);
});

test("scoreInstinctCandidates keeps project scopes separate", () => {
  const candidates = scoreInstinctCandidates({
    observations: [
      observation({ id: "obs_a", projectKey: "proj_a" }),
      observation({ id: "obs_b", projectKey: "proj_a" }),
      observation({ id: "obs_c", projectKey: "proj_b" }),
    ],
    minSignals: 2,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].projectKey, "proj_a");
  assert.deepEqual(candidates[0].observationIds, ["obs_a", "obs_b"]);
});

test("scoreInstinctCandidates caps confidence at 0.9", () => {
  const observations = Array.from({ length: 12 }, (_, i) =>
    observation({ id: `obs_${i}` }),
  );
  const candidates = scoreInstinctCandidates({ observations });
  assert.equal(candidates[0].confidence, 0.9);
});
