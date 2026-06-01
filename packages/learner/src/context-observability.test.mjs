import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextObservabilityService } from "./context-observability.ts";

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

test("ContextObservabilityService summarizes context packs and pinned outcomes", async () => {
  let listInput = null;
  const service = new ContextObservabilityService({
    state: {
      listObservations: async (input) => {
        listInput = input;
        return [
          observation({
            id: "obs-source-a",
            summary:
              "quality failed because api_key=super-secret-value leaked in logs",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
          observation({
            id: "obs-source-b",
            source: "runner",
            signal: "test",
            summary: "runner test failure required rebuild:node",
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
          observation({
            id: "ctx-no-pins",
            source: "agent",
            eventType: "context_pack_created",
            signal: "context_pack",
            summary: "created agent context pack",
            payload: {
              promptInclusion: {
                pinnedObservationIds: [],
              },
            },
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
          observation({
            id: "ctx-with-pins",
            source: "agent",
            eventType: "context_pack_created",
            signal: "context_pack",
            summary: "created agent context pack with pinned contexts",
            payload: {
              promptInclusion: {
                pinnedObservationIds: ["obs-source-a", "obs-source-b"],
              },
              contextPackArtifactId: "artifact-context-pack",
            },
            createdAt: "2026-01-01T00:00:04.000Z",
          }),
          observation({
            id: "outcome-pass",
            source: "learner",
            eventType: "pinned_context_outcome",
            signal: "passed",
            summary: "quality gate passed after pinned context",
            payload: {
              pinnedObservationIds: ["obs-source-a"],
              qualityStatus: "passed",
              outcomeSource: "quality",
            },
            createdAt: "2026-01-01T00:00:05.000Z",
          }),
          observation({
            id: "outcome-warning",
            source: "learner",
            eventType: "pinned_context_outcome",
            signal: "warning",
            summary: "quality gate warning after pinned context",
            payload: {
              pinnedObservationIds: ["obs-source-a", "obs-source-b"],
              qualityStatus: "warning",
              outcomeSource: "agent.generatePlan",
              contextPackObservationId: "ctx-with-pins",
            },
            createdAt: "2026-01-01T00:00:06.000Z",
          }),
          observation({
            id: "outcome-failed",
            source: "learner",
            eventType: "pinned_context_outcome",
            signal: "failed",
            summary:
              "quality gate failed after pinned context with api_key=super-secret-value",
            payload: {
              pinnedObservationIds: ["obs-source-b"],
              qualityStatus: "failed",
              outcomeSource: "runner.executeApproved",
              contextPackObservationId: "ctx-with-pins",
            },
            createdAt: "2026-01-01T00:00:07.000Z",
          }),
          observation({
            id: "decision-pin",
            source: "learner",
            eventType: "pinned_context_decision",
            signal: "pinned",
            summary: "user pinned recalled context obs-source-a",
            payload: {
              observationId: "obs-source-a",
              surface: "recommended",
              score: 0.42,
              reuseRisk: "low",
              secret: "api_key=super-secret-value",
            },
            createdAt: "2026-01-01T00:00:08.000Z",
          }),
          observation({
            id: "decision-unpin",
            source: "learner",
            eventType: "pinned_context_decision",
            signal: "unpinned",
            summary: "user unpinned recalled context obs-source-b",
            payload: {
              observationId: "obs-source-b",
              surface: "recall",
              score: 0.2,
              reuseRisk: "high",
            },
            createdAt: "2026-01-01T00:00:09.000Z",
          }),
          observation({
            id: "other-project",
            projectKey: "proj-b",
            source: "learner",
            eventType: "pinned_context_outcome",
            signal: "passed",
            payload: {
              pinnedObservationIds: ["obs-other"],
              qualityStatus: "passed",
            },
          }),
        ];
      },
    },
  });

  const summary = await service.summarize({
    taskRunId: "tr-current",
    projectKey: "proj-a",
    limit: 2,
  });

  assert.equal(listInput.projectKey, "proj-a");
  assert.equal(summary.taskRunId, "tr-current");
  assert.equal(summary.projectKey, "proj-a");
  assert.equal(summary.contextPackCount, 2);
  assert.equal(summary.pinnedContextPackCount, 1);
  assert.equal(summary.verifiedContextPackCount, 1);
  assert.equal(summary.pendingContextPackCount, 0);
  assert.equal(summary.outcomeCount, 3);
  assert.equal(summary.pinnedObservationUseCount, 4);
  assert.equal(summary.passedCount, 1);
  assert.equal(summary.warningCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.qualityOutcomeCount, 1);
  assert.equal(summary.agentOutcomeCount, 1);
  assert.equal(summary.runnerOutcomeCount, 1);
  assert.equal(summary.unknownOutcomeCount, 0);
  assert.equal(summary.contextDecisionCount, 2);
  assert.equal(summary.contextPinnedDecisionCount, 1);
  assert.equal(summary.contextUnpinnedDecisionCount, 1);
  assert.deepEqual(
    summary.topObservations.map((item) => ({
      id: item.observationId,
      used: item.usedCount,
      passed: item.passedCount,
      warning: item.warningCount,
      failed: item.failedCount,
      lastStatus: item.lastStatus,
      scoreAdjustment: item.scoreAdjustment,
      reuseRisk: item.reuseRisk,
    })),
    [
      {
        id: "obs-source-a",
        used: 2,
        passed: 1,
        warning: 1,
        failed: 0,
        lastStatus: "warning",
        scoreAdjustment: 0.35,
        reuseRisk: "medium",
      },
      {
        id: "obs-source-b",
        used: 2,
        passed: 0,
        warning: 1,
        failed: 1,
        lastStatus: "failed",
        scoreAdjustment: -0.25,
      reuseRisk: "high",
      },
    ],
  );
  assert.deepEqual(
    summary.recentOutcomes.map((item) => ({
      id: item.outcomeObservationId,
      taskRunId: item.taskRunId,
      status: item.status,
      source: item.outcomeSource,
      pinnedObservationIds: item.pinnedObservationIds,
      createdAt: item.createdAt,
    })),
    [
      {
        id: "outcome-failed",
        taskRunId: "tr-default",
        status: "failed",
        source: "runner",
        pinnedObservationIds: ["obs-source-b"],
        createdAt: "2026-01-01T00:00:07.000Z",
      },
      {
        id: "outcome-warning",
        taskRunId: "tr-default",
        status: "warning",
        source: "agent",
        pinnedObservationIds: ["obs-source-a", "obs-source-b"],
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    ],
  );
  assert.match(summary.recentOutcomes[0].summary, /\[REDACTED\]/);
  assert.equal(
    JSON.stringify(summary.recentOutcomes).includes("super-secret-value"),
    false,
  );
  assert.equal(JSON.stringify(summary.recentOutcomes).includes("qualityStatus"), false);
  assert.deepEqual(
    summary.recentContextPacks.map((item) => ({
      id: item.contextPackObservationId,
      taskRunId: item.taskRunId,
      artifactId: item.contextPackArtifactId,
      pinnedObservationIds: item.pinnedObservationIds,
      outcomeStatus: item.outcome?.status,
      outcomeSource: item.outcome?.outcomeSource,
      outcomeId: item.outcome?.outcomeObservationId,
      outcomeSummary: item.outcome?.summary,
    })),
    [
      {
        id: "ctx-with-pins",
        taskRunId: "tr-default",
        artifactId: "artifact-context-pack",
        pinnedObservationIds: ["obs-source-a", "obs-source-b"],
        outcomeStatus: "failed",
        outcomeSource: "runner",
        outcomeId: "outcome-failed",
        outcomeSummary: "quality gate failed after pinned context with [REDACTED]",
      },
    ],
  );
  assert.equal(JSON.stringify(summary.recentContextPacks).includes("qualityStatus"), false);
  assert.equal(
    JSON.stringify(summary.recentContextPacks).includes("super-secret-value"),
    false,
  );
  assert.deepEqual(
    summary.recentContextDecisions.map((item) => ({
      id: item.decisionObservationId,
      taskRunId: item.taskRunId,
      observationId: item.observationId,
      decision: item.decision,
      surface: item.surface,
      score: item.score,
      reuseRisk: item.reuseRisk,
      createdAt: item.createdAt,
    })),
    [
      {
        id: "decision-unpin",
        taskRunId: "tr-default",
        observationId: "obs-source-b",
        decision: "unpinned",
        surface: "recall",
        score: 0.2,
        reuseRisk: "high",
        createdAt: "2026-01-01T00:00:09.000Z",
      },
      {
        id: "decision-pin",
        taskRunId: "tr-default",
        observationId: "obs-source-a",
        decision: "pinned",
        surface: "recommended",
        score: 0.42,
        reuseRisk: "low",
        createdAt: "2026-01-01T00:00:08.000Z",
      },
    ],
  );
  assert.equal(JSON.stringify(summary.recentContextDecisions).includes("secret"), false);
  assert.equal(
    JSON.stringify(summary.recentContextDecisions).includes("super-secret-value"),
    false,
  );
  assert.match(summary.topObservations[0].summary, /\[REDACTED\]/);
  assert.equal(
    JSON.stringify(summary.topObservations).includes("super-secret-value"),
    false,
  );
});

test("ContextObservabilityService keeps risky context visible outside the top list limit", async () => {
  const service = new ContextObservabilityService({
    state: {
      listObservations: async () => [
        observation({
          id: "obs-proven",
          summary: "proved useful after repeated tests",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        observation({
          id: "obs-risky",
          summary: "caused a stale patch failure with token=secret-risk",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        observation({
          id: "outcome-pass-a",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "passed",
          summary: "passed after proven context",
          payload: {
            pinnedObservationIds: ["obs-proven"],
            qualityStatus: "passed",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
        observation({
          id: "outcome-pass-b",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "passed",
          summary: "passed again after proven context",
          payload: {
            pinnedObservationIds: ["obs-proven"],
            qualityStatus: "passed",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
        observation({
          id: "outcome-failed",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "failed",
          summary: "failed after risky context with token=secret-risk",
          payload: {
            pinnedObservationIds: ["obs-risky"],
            qualityStatus: "failed",
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      ],
    },
  });

  const summary = await service.summarize({
    taskRunId: "tr-current",
    projectKey: "proj-a",
    limit: 1,
  });

  assert.equal(summary.topObservations.length, 1);
  assert.equal(summary.topObservations[0].observationId, "obs-proven");
  assert.deepEqual(
    summary.riskObservations.map((item) => ({
      id: item.observationId,
      failed: item.failedCount,
      reuseRisk: item.reuseRisk,
      lastStatus: item.lastStatus,
      scoreAdjustment: item.scoreAdjustment,
    })),
    [
      {
        id: "obs-risky",
        failed: 1,
        reuseRisk: "high",
        lastStatus: "failed",
        scoreAdjustment: -0.35,
      },
    ],
  );
  assert.equal(
    JSON.stringify(summary.riskObservations).includes("secret-risk"),
    false,
  );
});

test("ContextObservabilityService counts pinned context packs waiting for outcomes", async () => {
  const service = new ContextObservabilityService({
    state: {
      listObservations: async () => [
        observation({
          id: "obs-source",
          summary: "use rebuild evidence when native tests fail",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        observation({
          id: "ctx-pending",
          source: "agent",
          eventType: "context_pack_created",
          signal: "context_pack",
          summary: "created context pack that has not been checked yet",
          payload: {
            promptInclusion: {
              pinnedObservationIds: ["obs-source"],
            },
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
        observation({
          id: "ctx-verified",
          source: "agent",
          eventType: "context_pack_created",
          signal: "context_pack",
          summary: "created context pack that later passed",
          payload: {
            promptInclusion: {
              pinnedObservationIds: ["obs-source"],
            },
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
        observation({
          id: "outcome-verified",
          source: "learner",
          eventType: "pinned_context_outcome",
          signal: "passed",
          summary: "quality gate passed after pinned context",
          payload: {
            pinnedObservationIds: ["obs-source"],
            qualityStatus: "passed",
            contextPackObservationId: "ctx-verified",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      ],
    },
  });

  const summary = await service.summarize({
    taskRunId: "tr-current",
    projectKey: "proj-a",
    limit: 5,
  });

  assert.equal(summary.contextPackCount, 2);
  assert.equal(summary.pinnedContextPackCount, 2);
  assert.equal(summary.verifiedContextPackCount, 1);
  assert.equal(summary.pendingContextPackCount, 1);
  assert.deepEqual(
    summary.recentContextPacks.map((item) => ({
      id: item.contextPackObservationId,
      hasOutcome: item.outcome !== undefined,
    })),
    [
      { id: "ctx-verified", hasOutcome: true },
      { id: "ctx-pending", hasOutcome: false },
    ],
  );
});
