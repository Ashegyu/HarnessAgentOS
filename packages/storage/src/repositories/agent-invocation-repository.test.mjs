import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, closeDb } from "../db.ts";
import { LocalStateService } from "../services/local-state-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-agent-invocation-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const profileInput = (overrides = {}) => ({
  name: "Budget Coder",
  description: "Tracks budget usage",
  category: "core",
  tags: ["budget"],
  provider: "codex",
  role: "coder",
  persona: "Budget-aware coding agent",
  tuning: {
    model: "gpt-5.5",
    timeoutMs: 600_000,
    stallTimeoutMs: 120_000,
    contextDepth: 6,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: false,
  ...overrides,
});

const createInvocation = async (
  state,
  targetDir,
  latencyMs,
  finishedAt,
  options = {},
) => {
  const thread = await state.createThread({ title: "Thread", targetDir });
  const taskRun = await state.createTaskRun({
    threadId: thread.id,
    userRequest: "Run agent",
    targetDir,
  });
  const prompt = await state.createArtifact({
    taskRunId: taskRun.id,
    kind: "plan",
    title: "Agent prompt",
    uri: `harness:test/${taskRun.id}/prompt`,
    summary: "prompt",
  });
  const invocation = await state.createAgentInvocation({
    taskRunId: taskRun.id,
    provider: "codex",
    model: options.model ?? "gpt-5",
    promptArtifactId: prompt.id,
    ...(options.profileId ? { profileId: options.profileId } : {}),
  });
  if (latencyMs !== null) {
    await state.updateAgentInvocation(invocation.id, {
      status: "succeeded",
      startedAt: "2026-05-18T00:00:00.000Z",
      finishedAt,
      latencyMs,
      ...(typeof options.costEstimate === "number"
        ? { costEstimate: options.costEstimate }
        : {}),
      ...(typeof options.inputTokens === "number"
        ? { inputTokens: options.inputTokens }
        : {}),
      ...(typeof options.outputTokens === "number"
        ? { outputTokens: options.outputTokens }
        : {}),
      ...(typeof options.totalTokens === "number"
        ? { totalTokens: options.totalTokens }
        : {}),
      ...(typeof options.usageApproximate === "boolean"
        ? { usageApproximate: options.usageApproximate }
        : {}),
    });
  }
  return { taskRun, invocation };
};

test("AgentInvocationRepository.listRecentWithLatency returns newest latency rows only", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const first = await createInvocation(
      state,
      t.dir,
      1200,
      "2026-05-18T00:01:00.000Z",
    );
    const second = await createInvocation(
      state,
      t.dir,
      800,
      "2026-05-18T00:02:00.000Z",
    );
    await createInvocation(state, t.dir, null, "2026-05-18T00:03:00.000Z");

    const recent = await state.agentInvocations.listRecentWithLatency(2);

    assert.deepEqual(
      recent.map((invocation) => invocation.id),
      [second.invocation.id, first.invocation.id],
    );
    assert.deepEqual(
      recent.map((invocation) => invocation.latencyMs),
      [800, 1200],
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentInvocationRepository persists profileId and summarizes cost by task run", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const profile = await state.agentProfiles.create(profileInput());
    const created = await createInvocation(
      state,
      t.dir,
      1200,
      "2026-05-18T00:01:00.000Z",
      {
        profileId: profile.id,
        model: "gpt-5.5",
        costEstimate: 0.42,
      },
    );

    const persisted = await state.getAgentInvocation(created.invocation.id);
    const summary = await state.summarizeAgentInvocationCostByTaskRun(
      created.taskRun.id,
    );

    assert.equal(persisted.profileId, profile.id);
    assert.equal(summary.totalCostUsd, 0.42);
    assert.equal(summary.totalLatencyMs, 1200);
    assert.equal(summary.invocationCount, 1);
    assert.deepEqual(summary.perModel, [
      { model: "gpt-5.5", cost: 0.42, latencyMs: 1200, count: 1 },
    ]);
    assert.deepEqual(summary.invocations, [
      {
        id: created.invocation.id,
        model: "gpt-5.5",
        cost: 0.42,
        latencyMs: 1200,
        createdAt: created.invocation.createdAt,
        success: true,
      },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentInvocationRepository exposes unknown invocation cost separately from zero-dollar spend", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const profile = await state.agentProfiles.create(profileInput());
    const created = await createInvocation(
      state,
      t.dir,
      900,
      "2026-05-18T00:01:00.000Z",
      {
        profileId: profile.id,
        model: "gpt-unknown-price",
      },
    );

    const summary = await state.summarizeAgentInvocationCostByTaskRun(
      created.taskRun.id,
    );

    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.knownCostInvocationCount, 0);
    assert.equal(summary.unknownCostInvocationCount, 1);
    assert.deepEqual(summary.perModel, [
      {
        model: "gpt-unknown-price",
        cost: 0,
        latencyMs: 900,
        count: 1,
        knownCostInvocationCount: 0,
        unknownCostInvocationCount: 1,
      },
    ]);
    assert.deepEqual(summary.invocations, [
      {
        id: created.invocation.id,
        model: "gpt-unknown-price",
        cost: 0,
        costKnown: false,
        latencyMs: 900,
        createdAt: created.invocation.createdAt,
        success: true,
      },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentInvocationRepository persists and summarizes token usage", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const profile = await state.agentProfiles.create(profileInput());
    const created = await createInvocation(
      state,
      t.dir,
      1200,
      "2026-05-18T00:01:00.000Z",
      {
        profileId: profile.id,
        model: "gpt-5.5",
        costEstimate: 0.42,
        inputTokens: 1000,
        outputTokens: 250,
        totalTokens: 1250,
        usageApproximate: false,
      },
    );

    const persisted = await state.getAgentInvocation(created.invocation.id);
    const summary = await state.summarizeAgentInvocationCostByTaskRun(
      created.taskRun.id,
    );

    assert.equal(persisted.inputTokens, 1000);
    assert.equal(persisted.outputTokens, 250);
    assert.equal(persisted.totalTokens, 1250);
    assert.equal(persisted.usageApproximate, false);
    assert.equal(summary.totalInputTokens, 1000);
    assert.equal(summary.totalOutputTokens, 250);
    assert.equal(summary.totalTokens, 1250);
    assert.deepEqual(summary.perModel, [
      {
        model: "gpt-5.5",
        cost: 0.42,
        latencyMs: 1200,
        count: 1,
        inputTokens: 1000,
        outputTokens: 250,
        totalTokens: 1250,
      },
    ]);
    assert.deepEqual(summary.invocations, [
      {
        id: created.invocation.id,
        model: "gpt-5.5",
        cost: 0.42,
        latencyMs: 1200,
        createdAt: created.invocation.createdAt,
        success: true,
        inputTokens: 1000,
        outputTokens: 250,
        totalTokens: 1250,
        usageApproximate: false,
      },
    ]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentInvocationRepository aggregates budget usage by invocation profile and day", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const coder = await state.agentProfiles.create(
      profileInput({ name: "Coder" }),
    );
    const reviewer = await state.agentProfiles.create(
      profileInput({ name: "Reviewer", isDefault: false }),
    );
    await createInvocation(state, t.dir, 100, "2026-05-18T01:00:00.000Z", {
      profileId: coder.id,
      model: "shared-model",
      costEstimate: 0.2,
    });
    await createInvocation(state, t.dir, 200, "2026-05-17T01:00:00.000Z", {
      profileId: coder.id,
      model: "shared-model",
      costEstimate: 0.3,
    });
    await createInvocation(state, t.dir, 300, "2026-05-18T02:00:00.000Z", {
      profileId: reviewer.id,
      model: "shared-model",
      costEstimate: 0.6,
    });

    const aggregates = await state.aggregateAgentInvocationCostByProfileAndDay({
      sinceIso: "2026-05-17T00:00:00.000Z",
      untilIso: "2026-05-18T23:59:59.999Z",
    });
    const topModels = await state.summarizeAgentInvocationModelCosts({
      sinceIso: "2026-05-17T00:00:00.000Z",
      untilIso: "2026-05-18T23:59:59.999Z",
    });

    const byProfileDate = (left, right) =>
      left.profileId.localeCompare(right.profileId) ||
      left.dateIso.localeCompare(right.dateIso);
    assert.deepEqual([...aggregates].sort(byProfileDate), [
      {
        profileId: coder.id,
        dateIso: "2026-05-17",
        totalCostUsd: 0.3,
        count: 1,
      },
      {
        profileId: coder.id,
        dateIso: "2026-05-18",
        totalCostUsd: 0.2,
        count: 1,
      },
      {
        profileId: reviewer.id,
        dateIso: "2026-05-18",
        totalCostUsd: 0.6,
        count: 1,
      },
    ].sort(byProfileDate));
    assert.deepEqual(topModels, [
      { model: "shared-model", totalCostUsd: 1.1, invocationCount: 3 },
    ]);
    assert.equal(
      await state.sumAgentInvocationCostByDay({
        profileId: coder.id,
        isoDate: "2026-05-18",
      }),
      0.2,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentInvocationRepository carries unknown cost counts through budget aggregates", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const state = new LocalStateService(db);
    const profile = await state.agentProfiles.create(profileInput());
    await createInvocation(state, t.dir, 100, "2026-05-18T01:00:00.000Z", {
      profileId: profile.id,
      model: "shared-model",
      costEstimate: 0.2,
    });
    await createInvocation(state, t.dir, 200, "2026-05-18T02:00:00.000Z", {
      profileId: profile.id,
      model: "shared-model",
    });

    const aggregates = await state.aggregateAgentInvocationCostByProfileAndDay({
      sinceIso: "2026-05-18T00:00:00.000Z",
      untilIso: "2026-05-18T23:59:59.999Z",
    });
    const topModels = await state.summarizeAgentInvocationModelCosts({
      sinceIso: "2026-05-18T00:00:00.000Z",
      untilIso: "2026-05-18T23:59:59.999Z",
    });

    assert.deepEqual(aggregates, [
      {
        profileId: profile.id,
        dateIso: "2026-05-18",
        totalCostUsd: 0.2,
        count: 2,
        knownCostInvocationCount: 1,
        unknownCostInvocationCount: 1,
      },
    ]);
    assert.deepEqual(topModels, [
      {
        model: "shared-model",
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
