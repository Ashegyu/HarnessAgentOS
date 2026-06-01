import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextPack,
  formatContextPackArtifactSummary,
  formatContextPackObservationPayload,
} from "./context-pack-builder.ts";

const taskRun = {
  id: "tr-context-pack",
  threadId: "th-context-pack",
  userRequest: "Fix the repeated test failure",
  targetDir: "/tmp/project",
  status: "drafting",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("buildContextPack captures provenance for prompt-shaping context", () => {
  const pack = buildContextPack({
    taskRun,
    profileId: "ap-reviewer",
    profileName: "Reviewer",
    qualityRisks: {
      id: "qg-failed",
      taskRunId: taskRun.id,
      status: "failed",
      testsPassed: false,
      knownRisks: ["npm run check failed"],
      evidenceArtifactIds: ["art-test-log"],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    instinctContexts: [
      {
        id: "instinct-quality",
        projectKey: "proj_1",
        scope: "project",
        title: "Prevent repeated quality gate failures",
        rule: "Require stronger evidence before marking similar work ready for review.",
        rationale: "3 matching failed quality gates.",
        confidence: 0.7,
        status: "active",
        sourceObservationIds: ["obs-1", "obs-2", "obs-3"],
        tags: ["evolved"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    capabilityContexts: [
      {
        capability: {
          id: "cap-tests",
          source: "skillify:project",
          name: "Test Repair",
          description: "Repair failing tests",
          triggerTerms: ["test", "repair"],
          riskLevel: "low",
          requiresApproval: false,
        },
        reason: "approved capability",
        instructions: "Run targeted tests first.",
      },
    ],
    threadContext: [
      {
        ordinal: 1,
        taskRunId: "tr-prior",
        userRequest: "Fix a similar failure",
        status: "ready_for_review",
        answerSummary: "Rebuilt native module before rerunning tests.",
      },
    ],
    recentArtifacts: [
      {
        id: "art-test-log",
        taskRunId: taskRun.id,
        kind: "test_result",
        title: "npm run check",
        uri: "harness:artifact/tr-context-pack/art-test-log",
        summary: "Type check failed",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ],
    repoContext: {
      section: "REPOSITORY CONTEXT\n- selected files: 2",
      selectedFiles: ["src/a.ts", "src/b.ts"],
      indexedFileCount: 12,
    },
    pinnedObservationContexts: [
      {
        observationId: "obs-quality-repair",
        taskRunId: "tr-prior",
        threadId: "th-prior",
        projectKey: "proj_1",
        source: "quality",
        eventType: "quality_gate",
        signal: "failed",
        summary: "A previous repair succeeded only after rebuilding better-sqlite3.",
        score: 0.91,
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: {
          usedCount: 1,
          passedCount: 0,
          warningCount: 0,
          failedCount: 1,
          lastStatus: "failed",
          lastOutcomeSource: "runner",
          lastSeenAt: "2026-01-01T00:00:03.000Z",
          qualityOutcomeCount: 0,
          agentOutcomeCount: 0,
          runnerOutcomeCount: 1,
          unknownOutcomeCount: 0,
          scoreAdjustment: -0.35,
          reuseRisk: "high",
        },
      },
    ],
  });

  assert.equal(pack.taskRunId, taskRun.id);
  assert.equal(pack.profileId, "ap-reviewer");
  assert.equal(pack.counts.instincts, 1);
  assert.equal(pack.counts.capabilities, 1);
  assert.equal(pack.counts.qualityRisks, 1);
  assert.equal(pack.counts.threadTasks, 1);
  assert.equal(pack.counts.recentArtifacts, 1);
  assert.equal(pack.counts.repoFiles, 2);
  assert.equal(pack.counts.pinnedObservations, 1);
  assert.ok(pack.sources.some((source) => source.kind === "instinct" && source.id === "instinct-quality"));
  assert.ok(pack.sources.some((source) => source.kind === "capability" && source.id === "cap-tests"));
  assert.ok(pack.sources.some((source) => source.kind === "quality_gate" && source.id === "qg-failed"));
  assert.ok(pack.sources.some((source) => source.kind === "artifact" && source.id === "art-test-log"));
  assert.ok(pack.sources.some((source) => source.kind === "pinned_observation" && source.id === "obs-quality-repair"));
  assert.deepEqual(pack.promptInclusion.pinnedObservationOutcomes, [
    {
      observationId: "obs-quality-repair",
      usedCount: 1,
      passedCount: 0,
      warningCount: 0,
      failedCount: 1,
      lastStatus: "failed",
      lastOutcomeSource: "runner",
      lastSeenAt: "2026-01-01T00:00:03.000Z",
      qualityOutcomeCount: 0,
      agentOutcomeCount: 0,
      runnerOutcomeCount: 1,
      unknownOutcomeCount: 0,
      scoreAdjustment: -0.35,
      reuseRisk: "high",
    },
  ]);
  assert.ok(pack.sections.some((section) => section.title === "Active Instincts"));
  assert.ok(pack.sections.some((section) => section.title === "Pinned Observations"));
});

test("formatContextPackArtifactSummary makes context inclusion auditable", () => {
  const pack = buildContextPack({
    taskRun,
    instinctContexts: [],
    capabilityContexts: [],
    recentArtifacts: [],
    threadContext: [],
    qualityRisks: null,
    repoContext: null,
  });

  const summary = formatContextPackArtifactSummary(pack);

  assert.match(summary, /# Agent Context Pack/);
  assert.match(summary, /taskRunId: tr-context-pack/);
  assert.match(summary, /active instincts: 0/);
  assert.match(summary, /approved capabilities: 0/);
  assert.match(summary, /pinned observations: 0/);
  assert.match(summary, /```json/);
});

test("formatContextPackObservationPayload stores compact non-prompt metadata", () => {
  const pack = buildContextPack({
    taskRun,
    profileId: "ap-reviewer",
    profileName: "Reviewer",
    instinctContexts: [
      {
        id: "instinct-quality",
        scope: "project",
        title: "Prevent repeated quality gate failures",
        rule: "Require stronger evidence before marking similar work ready for review.",
        rationale: "3 matching failed quality gates.",
        confidence: 0.7,
        status: "active",
        sourceObservationIds: ["obs-1"],
        tags: ["evolved"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    capabilityContexts: [],
    recentArtifacts: [],
    threadContext: [],
    qualityRisks: null,
    repoContext: {
      section: "SECRET_TOKEN=abc123",
      selectedFiles: ["src/private-a.ts", "src/private-b.ts"],
      indexedFileCount: 2,
    },
    pinnedObservationContexts: [
      {
        observationId: "obs-failed-context",
        source: "quality",
        eventType: "quality_gate",
        signal: "failed",
        summary: "A failed context summary with SECRET_TOKEN=abc123",
        score: 0.4,
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: {
          usedCount: 1,
          passedCount: 0,
          warningCount: 0,
          failedCount: 1,
          lastStatus: "failed",
          lastOutcomeSource: "agent",
          qualityOutcomeCount: 0,
          agentOutcomeCount: 1,
          runnerOutcomeCount: 0,
          unknownOutcomeCount: 0,
          scoreAdjustment: -0.35,
          reuseRisk: "high",
        },
      },
    ],
  });

  const payload = formatContextPackObservationPayload(pack, "art-context");

  assert.equal(payload.contextPackArtifactId, "art-context");
  assert.equal(payload.profileId, "ap-reviewer");
  assert.equal(payload.counts.repoFiles, 2);
  assert.equal(payload.counts.pinnedObservations, 1);
  assert.equal(payload.sourceKinds.instinct, 1);
  assert.equal(payload.sourceKinds.repo_context, 2);
  assert.equal(payload.sourceKinds.pinned_observation, 1);
  assert.equal(payload.promptInclusion.repoFileCount, 2);
  assert.deepEqual(payload.promptInclusion.instinctIds, ["instinct-quality"]);
  assert.deepEqual(payload.promptInclusion.pinnedObservationIds, ["obs-failed-context"]);
  assert.deepEqual(payload.promptInclusion.pinnedObservationOutcomes, [
    {
      observationId: "obs-failed-context",
      usedCount: 1,
      passedCount: 0,
      warningCount: 0,
      failedCount: 1,
      lastStatus: "failed",
      lastOutcomeSource: "agent",
      qualityOutcomeCount: 0,
      agentOutcomeCount: 1,
      runnerOutcomeCount: 0,
      unknownOutcomeCount: 0,
      scoreAdjustment: -0.35,
      reuseRisk: "high",
    },
  ]);
  assert.equal("repoFiles" in payload.promptInclusion, false);
  assert.equal(JSON.stringify(payload).includes("SECRET_TOKEN"), false);
  assert.equal(JSON.stringify(payload).includes("src/private-a.ts"), false);
  assert.equal(JSON.stringify(payload).includes("failed context summary"), false);
});
