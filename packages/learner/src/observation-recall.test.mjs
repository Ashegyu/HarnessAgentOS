import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservationRecallService } from "./observation-recall.ts";

const observation = (overrides = {}) => ({
  id: "obs-default",
  taskRunId: "tr-default",
  threadId: "th-default",
  projectKey: "proj-a",
  source: "quality",
  eventType: "failed",
  signal: "failed",
  summary: "quality gate failed after npm test",
  payload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("ObservationRecallService ranks matching project observations", async () => {
  let listInput = null;
  const service = new ObservationRecallService({
    state: {
      listObservations: async (input) => {
        listInput = input;
        return [
          observation({
            id: "obs-quality-failed",
            summary: "quality gate failed because targeted tests failed",
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
          observation({
            id: "obs-approval",
            source: "approval",
            eventType: "approved",
            signal: "file_write",
            summary: "file_write approved",
            createdAt: "2026-01-01T00:00:04.000Z",
          }),
          observation({
            id: "obs-other-project",
            projectKey: "proj-b",
            summary: "quality gate failed elsewhere",
            createdAt: "2026-01-01T00:00:05.000Z",
          }),
        ];
      },
    },
  });

  const results = await service.recall({
    projectKey: "proj-a",
    query: "quality tests failed",
    limit: 3,
  });

  assert.equal(listInput.projectKey, "proj-a");
  assert.equal(results[0].observationId, "obs-quality-failed");
  assert.equal(results.some((result) => result.observationId === "obs-other-project"), false);
  assert.ok(results[0].score > 0);
});

test("ObservationRecallService excludes the current task and redacts summaries", async () => {
  const service = new ObservationRecallService({
    state: {
      listObservations: async () => [
        observation({
          id: "obs-current",
          taskRunId: "tr-current",
          summary: "quality failed with the closest match",
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
        observation({
          id: "obs-prior",
          taskRunId: "tr-prior",
          summary: "quality failed because api_key=super-secret-value was logged",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      ],
    },
  });

  const results = await service.recall({
    projectKey: "proj-a",
    query: "quality failed",
    excludeTaskRunId: "tr-current",
  });

  assert.deepEqual(
    results.map((result) => result.observationId),
    ["obs-prior"],
  );
  assert.match(results[0].summary, /\[REDACTED\]/);
  assert.equal(results[0].summary.includes("super-secret-value"), false);
});

test("ObservationRecallService returns no results for empty queries", async () => {
  let calls = 0;
  const service = new ObservationRecallService({
    state: {
      listObservations: async () => {
        calls += 1;
        return [observation()];
      },
    },
  });

  const results = await service.recall({ query: "   " });

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("ObservationRecallService annotates and boosts recalled observations with positive pinned outcomes", async () => {
  const service = new ObservationRecallService({
    state: {
      listObservations: async () => [
        observation({
          id: "obs-helped",
          taskRunId: "tr-prior-helped",
          summary: "quality failed because rebuild native module was required",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        observation({
          id: "obs-noisy",
          taskRunId: "tr-prior-noisy",
          summary: "quality failed because rebuild native module was required",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
        observation({
          id: "obs-outcome-helped",
          taskRunId: "tr-outcome-helped",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "passed",
          summary: "quality gate passed after 1 pinned observations",
          payload: {
            pinnedObservationIds: ["obs-helped"],
            qualityStatus: "passed",
            outcomeSource: "quality",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
        observation({
          id: "obs-outcome-noisy",
          taskRunId: "tr-outcome-noisy",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "failed",
          summary: "quality gate failed after 1 pinned observations",
          payload: {
            pinnedObservationIds: ["obs-noisy"],
            qualityStatus: "failed",
            outcomeSource: "runner.executeApproved",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ],
    },
  });

  const results = await service.recall({
    projectKey: "proj-a",
    query: "quality failed rebuild native module",
    limit: 4,
  });

  assert.deepEqual(
    results.map((result) => result.observationId),
    ["obs-helped", "obs-noisy"],
  );
  assert.deepEqual(results[0].outcome, {
    usedCount: 1,
    passedCount: 1,
    warningCount: 0,
    failedCount: 0,
    lastStatus: "passed",
    lastOutcomeSource: "quality",
    lastSeenAt: "2026-01-01T00:00:04.000Z",
    qualityOutcomeCount: 1,
    agentOutcomeCount: 0,
    runnerOutcomeCount: 0,
    unknownOutcomeCount: 0,
    scoreAdjustment: 0.25,
    reuseRisk: "low",
  });
  assert.deepEqual(results[1].outcome, {
    usedCount: 1,
    passedCount: 0,
    warningCount: 0,
    failedCount: 1,
    lastStatus: "failed",
    lastOutcomeSource: "runner",
    lastSeenAt: "2026-01-01T00:00:05.000Z",
    qualityOutcomeCount: 0,
    agentOutcomeCount: 0,
    runnerOutcomeCount: 1,
    unknownOutcomeCount: 0,
    scoreAdjustment: -0.35,
    reuseRisk: "high",
  });
  assert.ok(results[0].score > results[1].score);
  assert.equal(
    results.some((result) => result.observationId === "obs-outcome-helped"),
    false,
  );
});

test("ObservationRecallService strongly suppresses contexts with only failed pinned outcomes", async () => {
  const service = new ObservationRecallService({
    state: {
      listObservations: async () => [
        observation({
          id: "obs-failed-reuse",
          taskRunId: "tr-prior-failed",
          summary:
            "native rebuild fix failed because the same context produced another quality failure",
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
        observation({
          id: "obs-neutral",
          taskRunId: "tr-prior-neutral",
          summary: "native rebuild fix quality failure",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        observation({
          id: "obs-failed-reuse-outcome",
          taskRunId: "tr-outcome-failed",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "failed",
          summary: "quality gate failed after pinned context",
          payload: {
            pinnedObservationIds: ["obs-failed-reuse"],
            qualityStatus: "failed",
            outcomeSource: "agent.generatePlan",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      ],
    },
  });

  const results = await service.recall({
    projectKey: "proj-a",
    query: "native rebuild fix quality failure",
    limit: 2,
  });

  assert.deepEqual(
    results.map((result) => result.observationId),
    ["obs-neutral", "obs-failed-reuse"],
  );
  assert.deepEqual(results[1].outcome, {
    usedCount: 1,
    passedCount: 0,
    warningCount: 0,
    failedCount: 1,
    lastStatus: "failed",
    lastOutcomeSource: "agent",
    lastSeenAt: "2026-01-01T00:00:04.000Z",
    qualityOutcomeCount: 0,
    agentOutcomeCount: 1,
    runnerOutcomeCount: 0,
    unknownOutcomeCount: 0,
    scoreAdjustment: -0.35,
    reuseRisk: "high",
  });
});
