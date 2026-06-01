import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  closeDb,
  LocalStateService,
} from "../../../packages/storage/src/index.ts";
import { LearnerAdvisor } from "./learner-advisor.ts";
import { deriveProjectKey } from "./project-key.ts";
import { TraceRecorder } from "./trace-recorder.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-advisor-"));
  return {
    dir,
    file: join(dir, "test.db"),
    decisionsDir: join(dir, "decisions"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state, request = "refactor and rename helper") => {
  const thread = await state.createThread({
    title: "t",
    targetDir: "/tmp/proj",
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: request,
    targetDir: "/tmp/proj",
    status: "running",
  });
};

const profileInput = (overrides = {}) => ({
  name: "Cost-aware coder",
  description: "Tracks spend",
  category: "core",
  tags: ["cost"],
  provider: "codex",
  role: "coder",
  persona: "Cost-aware coding agent",
  tuning: {
    model: "gpt-5.5",
    timeoutMs: 600_000,
    stallTimeoutMs: 120_000,
    contextDepth: 6,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: {
    cliPathOverride: "",
    env: {},
    envSecretRefs: {},
  },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
    budget: {
      perInvocationUsd: 0.3,
      perTaskRunUsd: 0.4,
      perDayUsd: 1,
    },
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: true,
  ...overrides,
});

const createCostedInvocation = async (
  state,
  taskRun,
  {
    provider = "codex",
    model = "gpt-5.5",
    profileId,
    status = "succeeded",
    costEstimate,
    latencyMs,
    finishedAt,
  } = {},
) => {
  const promptArtifact = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "log",
    title: `prompt ${model}`,
    uri: `memory://prompt/${taskRun.id}/${model}/${Math.random()}`,
  });
  const invocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider,
    model,
    promptArtifactId: promptArtifact.id,
    ...(profileId ? { profileId } : {}),
  });
  await state.updateAgentInvocation(invocation.id, {
    status,
    ...(typeof latencyMs === "number" ? { latencyMs } : {}),
    ...(typeof costEstimate === "number" ? { costEstimate } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  });
  return invocation;
};

test("recommend returns conservative fallback with no history", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const rec = await advisor.recommend({ taskRunId: taskRun.id });
    assert.deepEqual(rec.recommendedCapabilities, []);
    assert.deepEqual(rec.recommendedContext, []);
    assert.match(rec.rationale, /No prior trace history/i);
    assert.ok(rec.confidence < 0.5);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recallContext returns redacted prior observations for the same project", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const current = await seedTaskRun(state, "repair quality failed tests");
    const prior = await seedTaskRun(state, "fix earlier quality failure");
    const projectKey = await deriveProjectKey({ targetDir: current.targetDir });
    await state.createObservation({
      taskRunId: current.id,
      threadId: current.threadId,
      projectKey,
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "current quality failed and should be excluded",
      payload: {},
    });
    const priorObservation = await state.createObservation({
      taskRunId: prior.id,
      threadId: prior.threadId,
      projectKey,
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "quality failed because api_key=super-secret-value leaked in logs",
      payload: { raw: "do not return payload" },
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const results = await advisor.recallContext({
      taskRunId: current.id,
      query: "quality failed",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].observationId, priorObservation.id);
    assert.equal(results[0].taskRunId, prior.id);
    assert.match(results[0].summary, /\[REDACTED\]/);
    assert.equal(JSON.stringify(results).includes("super-secret-value"), false);
    assert.equal(JSON.stringify(results).includes("do not return payload"), false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend includes safe prior context candidates and excludes high-risk reuse", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const current = await seedTaskRun(
      state,
      "repair quality failed tests after native module mismatch",
    );
    const prior = await seedTaskRun(
      state,
      "repair quality failed tests after native module mismatch",
    );
    const projectKey = await deriveProjectKey({ targetDir: current.targetDir });
    const helpful = await state.createObservation({
      taskRunId: prior.id,
      threadId: prior.threadId,
      projectKey,
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary:
        "quality failed because better-sqlite3 native module mismatch required npm run rebuild:node",
      payload: { raw: "do not expose this payload" },
    });
    const risky = await state.createObservation({
      taskRunId: prior.id,
      threadId: prior.threadId,
      projectKey,
      source: "runner",
      eventType: "failed",
      signal: "failed",
      summary:
        "quality failed after deleting cache and retrying the same native module repair",
      payload: {},
    });
    await state.createObservation({
      taskRunId: prior.id,
      threadId: prior.threadId,
      projectKey,
      source: "learner",
      eventType: "pinned_context_outcome",
      signal: "failed",
      summary: "runner failed after risky pinned context",
      payload: {
        pinnedObservationIds: [risky.id],
        outcomeSource: "runner.executeApproved",
      },
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const rec = await advisor.recommend({ taskRunId: current.id });

    assert.ok(Array.isArray(rec.recommendedContext));
    assert.equal(rec.recommendedContext[0].observationId, helpful.id);
    assert.equal(
      rec.recommendedContext.some((item) => item.observationId === risky.id),
      false,
    );
    assert.match(rec.recommendedContext[0].summary, /rebuild:node/);
    assert.equal(JSON.stringify(rec.recommendedContext).includes("do not expose"), false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordContextDecision stores bounded context pin decisions as observations", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, "repair quality failed tests");
    const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
    const source = await state.createObservation({
      taskRunId: taskRun.id,
      threadId: taskRun.threadId,
      projectKey,
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "quality failed because api_key=super-secret-value leaked",
      payload: { raw: "do not copy" },
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    await advisor.recordContextDecision({
      taskRunId: taskRun.id,
      observationId: source.id,
      decision: "pinned",
      surface: "recommended",
      score: 0.42,
      reuseRisk: "low",
    });

    const observations = await state.listObservations({ projectKey });
    const decision = observations.find(
      (item) => item.eventType === "pinned_context_decision",
    );
    assert.ok(decision, "context decision observation must be recorded");
    assert.equal(decision.taskRunId, taskRun.id);
    assert.equal(decision.threadId, taskRun.threadId);
    assert.equal(decision.projectKey, projectKey);
    assert.equal(decision.source, "learner");
    assert.equal(decision.signal, "pinned");
    assert.match(decision.summary, /user pinned recalled context/);
    assert.equal(decision.payload.observationId, source.id);
    assert.equal(decision.payload.surface, "recommended");
    assert.equal(decision.payload.score, 0.42);
    assert.equal(decision.payload.reuseRisk, "low");
    assert.equal(JSON.stringify(decision).includes("super-secret-value"), false);
    assert.equal(JSON.stringify(decision).includes("do not copy"), false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("summarizeContextOutcomes derives the current project outcome summary", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const current = await seedTaskRun(state, "repair with prior context");
    const prior = await seedTaskRun(state, "prior quality failure");
    const otherThread = await state.createThread({
      title: "other",
      targetDir: "/tmp/other",
    });
    const other = await state.createTaskRun({
      threadId: otherThread.id,
      userRequest: "other project",
      targetDir: "/tmp/other",
      status: "running",
    });
    const projectKey = await deriveProjectKey({ targetDir: current.targetDir });
    const otherProjectKey = await deriveProjectKey({ targetDir: "/tmp/other" });
    const source = await state.createObservation({
      taskRunId: prior.id,
      threadId: prior.threadId,
      projectKey,
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "quality failed because rebuild:node was required",
      payload: {},
    });
    await state.createObservation({
      taskRunId: current.id,
      threadId: current.threadId,
      projectKey,
      source: "agent",
      eventType: "context_pack_created",
      signal: "context_pack",
      summary: "created agent context pack with pinned context",
      payload: {
        promptInclusion: {
          pinnedObservationIds: [source.id],
        },
      },
    });
    await state.createObservation({
      taskRunId: current.id,
      threadId: current.threadId,
      projectKey,
      source: "learner",
      eventType: "pinned_context_outcome",
      signal: "passed",
      summary: "quality gate passed after pinned context",
      payload: {
        pinnedObservationIds: [source.id],
        qualityStatus: "passed",
      },
    });
    await state.createObservation({
      taskRunId: other.id,
      threadId: other.threadId,
      projectKey: otherProjectKey,
      source: "learner",
      eventType: "pinned_context_outcome",
      signal: "failed",
      summary: "other project failure",
      payload: {
        pinnedObservationIds: ["obs-other"],
        qualityStatus: "failed",
      },
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const summary = await advisor.summarizeContextOutcomes({
      taskRunId: current.id,
      limit: 5,
    });

    assert.equal(summary.taskRunId, current.id);
    assert.equal(summary.projectKey, projectKey);
    assert.equal(summary.contextPackCount, 1);
    assert.equal(summary.pinnedContextPackCount, 1);
    assert.equal(summary.outcomeCount, 1);
    assert.equal(summary.passedCount, 1);
    assert.equal(summary.failedCount, 0);
    assert.equal(summary.topObservations[0].observationId, source.id);
    assert.equal(summary.topObservations[0].usedCount, 1);
    assert.equal(summary.topObservations[0].scoreAdjustment, 0.25);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recommend ranks capabilities by trigger overlap and trace history", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    await state.upsertCapability({
      id: "cap_refactor",
      source: "skillify:test",
      name: "refactor",
      description: "r",
      triggerTerms: ["refactor", "rename"],
      riskLevel: "low",
      requiresApproval: false,
    });
    await state.upsertCapability({
      id: "cap_build",
      source: "skillify:test",
      name: "build",
      description: "b",
      triggerTerms: ["build"],
      riskLevel: "low",
      requiresApproval: false,
    });
    // Seed a successful prior trace that used the refactor capability.
    const recorder = new TraceRecorder({ state });
    const oldTaskRun = await seedTaskRun(state, "refactor previously");
    await recorder.recordSelection({
      taskRunId: oldTaskRun.id,
      selectedModel: "claude-sonnet-4-6",
      selectedCapabilities: ["cap_refactor"],
    });
    await recorder.recordOutcome({
      taskRunId: oldTaskRun.id,
      qualityGate: {
        id: "qg_1",
        taskRunId: oldTaskRun.id,
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: "2024-01-01T00:00:00Z",
      },
      latencyMs: 4_000,
      costEstimate: 0.02,
      success: true,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const rec = await advisor.recommend({ taskRunId: taskRun.id });
    assert.ok(rec.recommendedCapabilities.length >= 1);
    assert.equal(rec.recommendedCapabilities[0].capability.id, "cap_refactor");
    assert.equal(rec.recommendedModel, "claude-sonnet-4-6");
    assert.equal(rec.estimatedCostUsd, 0.02);
    assert.equal(rec.costHint, "low");
    assert.equal(rec.latencyHint, "low");
    assert.ok(rec.confidence > 0.2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordDecision appends to decisions.jsonl", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    await advisor.recordDecision({
      taskRunId: "tsk_test",
      recommendationId: "rec_1",
      decision: "rejected",
      reason: "too expensive",
    });
    const file = join(t.decisionsDir, "decisions.jsonl");
    assert.ok(existsSync(file));
    const content = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.taskRunId, "tsk_test");
    assert.equal(parsed.decision, "rejected");
    assert.equal(parsed.reason, "too expensive");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("summarizeTaskRunCost adds active profile budget progress and invocation status counts", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state, "implement cost panel");
    const profile = await state.agentProfiles.create(profileInput());
    await state.updateSettings({
      ...(await state.getSettings()),
      activeAgentProfileId: profile.id,
    });

    const today = new Date().toISOString().slice(0, 10);
    const succeeded = await createCostedInvocation(state, taskRun, {
      provider: "codex",
      model: "gpt-5.5",
      profileId: profile.id,
      status: "succeeded",
      costEstimate: 0.125,
      latencyMs: 1_000,
      finishedAt: `${today}T01:00:00.000Z`,
    });
    const failed = await createCostedInvocation(state, taskRun, {
      provider: "claude",
      model: "claude-opus",
      status: "failed",
      costEstimate: 0.375,
      latencyMs: 2_000,
      finishedAt: `${today}T01:01:00.000Z`,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const summary = await advisor.summarizeTaskRunCost({
      taskRunId: taskRun.id,
    });

    assert.equal(summary.totalCostUsd, 0.5);
    assert.equal(summary.totalLatencyMs, 3_000);
    assert.equal(summary.invocationCount, 2);
    assert.deepEqual(summary.agentInvocationStatusCounts, {
      queued: 0,
      running: 0,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    });
    assert.equal(summary.budget.profileId, profile.id);
    assert.deepEqual(
      summary.budget.progress.map((row) => ({
        scope: row.scope,
        usedUsd: row.usedUsd,
        limitUsd: row.limitUsd,
        exceeded: row.exceeded,
      })),
      [
        {
          scope: "per_invocation",
          usedUsd: 0.375,
          limitUsd: 0.3,
          exceeded: true,
        },
        {
          scope: "per_task_run",
          usedUsd: 0.5,
          limitUsd: 0.4,
          exceeded: true,
        },
        {
          scope: "per_day",
          usedUsd: 0.125,
          limitUsd: 1,
          exceeded: false,
        },
      ],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("summarizeBudgetUsage returns profile trends, daily totals, and top models", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date(`${today}T00:00:00.000Z`);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterday = yesterdayDate.toISOString().slice(0, 10);
    const coder = await state.agentProfiles.create(
      profileInput({ name: "Coder", tuning: { ...profileInput().tuning, model: "gpt-5.5" } }),
    );
    const reviewer = await state.agentProfiles.create(
      profileInput({
        name: "Reviewer",
        tuning: { ...profileInput().tuning, model: "claude-opus" },
        isDefault: false,
      }),
    );
    const coderTask = await seedTaskRun(state, "code");
    const reviewerTask = await seedTaskRun(state, "review");
    await createCostedInvocation(state, coderTask, {
      model: "gpt-5.5",
      profileId: coder.id,
      costEstimate: 0.2,
      latencyMs: 100,
      finishedAt: `${today}T01:00:00.000Z`,
    });
    await createCostedInvocation(state, coderTask, {
      model: "gpt-5.5",
      profileId: coder.id,
      costEstimate: 0.3,
      latencyMs: 100,
      finishedAt: `${yesterday}T01:00:00.000Z`,
    });
    await createCostedInvocation(state, reviewerTask, {
      provider: "claude",
      model: "claude-opus",
      profileId: reviewer.id,
      costEstimate: 0.6,
      latencyMs: 100,
      finishedAt: `${today}T02:00:00.000Z`,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const summary = await advisor.summarizeBudgetUsage({ days: 2 });

    assert.equal(summary.days, 2);
    assert.equal(summary.todayCostUsd, 0.8);
    assert.equal(summary.windowCostUsd, 1.1);
    assert.deepEqual(
      summary.profiles.map((profile) => ({
        id: profile.profileId,
        today: profile.todayCostUsd,
        window: profile.windowCostUsd,
      })),
      [
        { id: coder.id, today: 0.2, window: 0.5 },
        { id: reviewer.id, today: 0.6, window: 0.6 },
      ],
    );
    assert.deepEqual(
      summary.topModels.map((model) => ({
        model: model.model,
        total: model.totalCostUsd,
        count: model.invocationCount,
      })),
      [
        { model: "claude-opus", total: 0.6, count: 1 },
        { model: "gpt-5.5", total: 0.5, count: 2 },
      ],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("summarizeBudgetUsage carries unknown cost counts from agent invocations", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const profile = await state.agentProfiles.create(
      profileInput({ name: "Unknown Cost Coder" }),
    );
    const taskRun = await seedTaskRun(state, "code with unknown pricing");
    await createCostedInvocation(state, taskRun, {
      model: "gpt-unknown-price",
      profileId: profile.id,
      costEstimate: 0.2,
      latencyMs: 100,
      finishedAt: `${today}T01:00:00.000Z`,
    });
    await createCostedInvocation(state, taskRun, {
      model: "gpt-unknown-price",
      profileId: profile.id,
      latencyMs: 100,
      finishedAt: `${today}T02:00:00.000Z`,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const summary = await advisor.summarizeBudgetUsage({ days: 1 });
    const profileSummary = summary.profiles.find(
      (item) => item.profileId === profile.id,
    );

    assert.equal(summary.windowCostUsd, 0.2);
    assert.equal(summary.knownCostInvocationCount, 1);
    assert.equal(summary.unknownCostInvocationCount, 1);
    assert.equal(profileSummary.knownCostInvocationCount, 1);
    assert.equal(profileSummary.unknownCostInvocationCount, 1);
    assert.deepEqual(profileSummary.daily, [
      {
        dateIso: today,
        totalCostUsd: 0.2,
        count: 2,
        knownCostInvocationCount: 1,
        unknownCostInvocationCount: 1,
      },
    ]);
    assert.deepEqual(summary.topModels, [
      {
        model: "gpt-unknown-price",
        totalCostUsd: 0.2,
        invocationCount: 2,
        knownCostInvocationCount: 1,
        unknownCostInvocationCount: 1,
      },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("proposeRecommendationApprovals creates model_use and capability_use approvals without duplicates", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    await state.upsertCapability({
      id: "cap_refactor",
      source: "skillify:test",
      name: "refactor",
      description: "r",
      triggerTerms: ["refactor", "rename"],
      riskLevel: "low",
      requiresApproval: false,
    });
    const recorder = new TraceRecorder({ state });
    const oldTaskRun = await seedTaskRun(state, "refactor previously");
    await recorder.recordSelection({
      taskRunId: oldTaskRun.id,
      selectedModel: "gpt-5.5",
      selectedCapabilities: ["cap_refactor"],
    });
    await recorder.recordOutcome({
      taskRunId: oldTaskRun.id,
      qualityGate: {
        id: "qg_1",
        taskRunId: oldTaskRun.id,
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: "2024-01-01T00:00:00Z",
      },
      costEstimate: 0.07,
      success: true,
    });

    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const first = await advisor.proposeRecommendationApprovals({
      taskRunId: taskRun.id,
    });
    assert.equal(first.recommendation.recommendedModel, "gpt-5.5");
    assert.deepEqual(
      first.approvals.map((a) => a.actionType).sort(),
      ["capability_use", "model_use"],
    );
    assert.equal(
      first.approvals.find((a) => a.actionType === "model_use")
        .proposedAction.modelUse.model,
      "gpt-5.5",
    );
    assert.equal(
      first.approvals.find((a) => a.actionType === "model_use")
        .proposedAction.modelUse.estimatedCostUsd,
      0.07,
    );
    assert.equal(
      first.approvals.find((a) => a.actionType === "model_use")
        .policyEvaluation.costEstimateUsd,
      0.07,
    );
    assert.match(
      first.approvals.find((a) => a.actionType === "capability_use")
        .proposedAction.capabilityUse.reason,
      /Learner trace 추천/,
    );

    const second = await advisor.proposeRecommendationApprovals({
      taskRunId: taskRun.id,
    });
    assert.equal(second.approvals.length, 0);
    assert.equal(second.skipped.length, 2);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("approvedModelContext returns model only after model_use approval", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const taskRun = await seedTaskRun(state);
    const recorder = new TraceRecorder({ state });
    const oldTaskRun = await seedTaskRun(state, "previous coding");
    await recorder.recordSelection({
      taskRunId: oldTaskRun.id,
      selectedModel: "gpt-5.5",
      selectedCapabilities: [],
    });
    await recorder.recordOutcome({
      taskRunId: oldTaskRun.id,
      qualityGate: {
        id: "qg_1",
        taskRunId: oldTaskRun.id,
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: "2024-01-01T00:00:00Z",
      },
      success: true,
    });
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const proposed = await advisor.proposeRecommendationApprovals({
      taskRunId: taskRun.id,
    });
    const modelApproval = proposed.approvals.find(
      (a) => a.actionType === "model_use",
    );
    assert.ok(modelApproval);
    assert.equal(
      await advisor.approvedModelContext({ taskRunId: taskRun.id }),
      null,
    );

    await state.decideApproval(modelApproval.id, "approved", "use learner model");
    const context = await advisor.approvedModelContext({
      taskRunId: taskRun.id,
    });
    assert.equal(context.model, "gpt-5.5");
    assert.equal(context.recommendationId, proposed.recommendation.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("recordDecision redacts secrets and caps reason length", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const advisor = new LearnerAdvisor({
      state,
      decisionLogDir: t.decisionsDir,
    });
    const longTail = "x".repeat(500);
    await advisor.recordDecision({
      taskRunId: "tsk_test",
      recommendationId: "rec_1",
      decision: "rejected",
      reason: `leaked api_key=sk-abcdef123 and ghp_${"A".repeat(30)} ${longTail}`,
    });
    const file = join(t.decisionsDir, "decisions.jsonl");
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    assert.ok(!/sk-abcdef123/.test(parsed.reason));
    assert.ok(!/ghp_AAA/.test(parsed.reason));
    assert.match(parsed.reason, /\[REDACTED\]/);
    assert.ok(parsed.reason.length <= 240);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
