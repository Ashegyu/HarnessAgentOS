import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteAgentProfileRepository } from "./agent-profile-repository.ts";
import { SqliteLearningTraceRepository } from "./learning-trace-repository.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-lt-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = (db, id) => {
  db.prepare(
    `INSERT OR IGNORE INTO threads(id, title, target_dir, created_at, updated_at)
     VALUES('thr_cost', 'Thread', '/tmp/project', '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
     VALUES(?, 'thr_cost', 'Do it', '/tmp/project', 'done', NULL, '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z')`,
  ).run(id);
};

const profileInput = (name, model, isDefault = false) => ({
  name,
  description: "",
  category: "core",
  tags: [],
  provider: "codex",
  role: "coder",
  persona: "",
  tuning: {
    model,
    timeoutMs: 600_000,
    stallTimeoutMs: 120_000,
    contextDepth: 4,
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
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault,
});

test("LearningTraceRepository sums cost by TaskRun and ISO day", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedTaskRun(db, "tsk_a");
    seedTaskRun(db, "tsk_b");
    const repo = new SqliteLearningTraceRepository(db);
    const a = await repo.create({ taskRunId: "tsk_a" });
    const b = await repo.create({ taskRunId: "tsk_b" });
    await repo.update(a.id, { costEstimate: 0.4 });
    await repo.update(b.id, { costEstimate: 0.3 });
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T01:00:00.000Z",
      a.id,
    );
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T02:00:00.000Z",
      b.id,
    );

    assert.equal(await repo.sumCostByTaskRun("tsk_a"), 0.4);
    assert.equal(
      await repo.sumCostByDay({ isoDate: "2026-05-18" }),
      0.7,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("LearningTraceRepository aggregates profile/day usage for empty, single, and multiple profile data", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const traces = new SqliteLearningTraceRepository(db);
    const profiles = new SqliteAgentProfileRepository(db);
    const coder = await profiles.create(profileInput("Coder", "gpt-5.6-sol", true));
    const reviewer = await profiles.create(
      profileInput("Reviewer", "gpt-5.6-terra", false),
    );

    const empty = await traces.aggregateByProfileAndDay({
      sinceIso: "2026-05-18T00:00:00.000Z",
      untilIso: "2026-05-18T23:59:59.999Z",
    });
    assert.deepEqual(empty, []);

    seedTaskRun(db, "tsk_profile_a");
    seedTaskRun(db, "tsk_profile_b");
    const first = await traces.create({ taskRunId: "tsk_profile_a" });
    const second = await traces.create({ taskRunId: "tsk_profile_a" });
    const third = await traces.create({ taskRunId: "tsk_profile_b" });
    await traces.update(first.id, {
      selectedModel: "gpt-5.6-sol",
      costEstimate: 0.2,
    });
    await traces.update(second.id, {
      selectedModel: "gpt-5.6-sol",
      costEstimate: 0.3,
    });
    await traces.update(third.id, {
      selectedModel: "gpt-5.6-terra",
      costEstimate: 0.7,
    });
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T01:00:00.000Z",
      first.id,
    );
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T02:00:00.000Z",
      second.id,
    );
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-19T01:00:00.000Z",
      third.id,
    );

    assert.deepEqual(
      await traces.aggregateByProfileAndDay({
        sinceIso: "2026-05-18T00:00:00.000Z",
        untilIso: "2026-05-19T23:59:59.999Z",
        profileId: coder.id,
      }),
      [
        {
          profileId: coder.id,
          dateIso: "2026-05-18",
          totalCostUsd: 0.5,
          count: 2,
        },
      ],
    );
    assert.deepEqual(
      await traces.aggregateByProfileAndDay({
        sinceIso: "2026-05-18T00:00:00.000Z",
        untilIso: "2026-05-19T23:59:59.999Z",
      }),
      [
        {
          profileId: coder.id,
          dateIso: "2026-05-18",
          totalCostUsd: 0.5,
          count: 2,
        },
        {
          profileId: reviewer.id,
          dateIso: "2026-05-19",
          totalCostUsd: 0.7,
          count: 1,
        },
      ],
    );
    assert.equal(
      await traces.sumCostByDay({
        profileId: coder.id,
        isoDate: "2026-05-18",
      }),
      0.5,
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("LearningTraceRepository summarizes cost, latency, and model breakdown by TaskRun", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    seedTaskRun(db, "tsk_cost");
    seedTaskRun(db, "tsk_other");
    const repo = new SqliteLearningTraceRepository(db);
    const first = await repo.create({ taskRunId: "tsk_cost" });
    const second = await repo.create({ taskRunId: "tsk_cost" });
    const third = await repo.create({ taskRunId: "tsk_other" });

    await repo.update(first.id, {
      selectedModel: "gpt-5.6-sol",
      costEstimate: 0.25,
      latencyMs: 1200,
      success: true,
    });
    await repo.update(second.id, {
      selectedModel: "gpt-5.6-sol",
      costEstimate: 0.15,
      latencyMs: 800,
      success: false,
    });
    await repo.update(third.id, {
      selectedModel: "gpt-5.6-terra",
      costEstimate: 0.7,
      latencyMs: 2000,
      success: true,
    });
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T01:00:00.000Z",
      first.id,
    );
    db.prepare(`UPDATE learning_traces SET created_at = ? WHERE id = ?`).run(
      "2026-05-18T01:02:00.000Z",
      second.id,
    );

    const summary = await repo.summarizeByTaskRun("tsk_cost");

    assert.equal(summary.taskRunId, "tsk_cost");
    assert.equal(summary.totalCostUsd, 0.4);
    assert.equal(summary.totalLatencyMs, 2000);
    assert.equal(summary.invocationCount, 2);
    assert.deepEqual(summary.perModel, [
      {
        model: "gpt-5.6-sol",
        cost: 0.4,
        latencyMs: 2000,
        count: 2,
      },
    ]);
    assert.deepEqual(
      summary.invocations.map((item) => ({
        model: item.model,
        cost: item.cost,
        latencyMs: item.latencyMs,
        success: item.success,
      })),
      [
        { model: "gpt-5.6-sol", cost: 0.25, latencyMs: 1200, success: true },
        { model: "gpt-5.6-sol", cost: 0.15, latencyMs: 800, success: false },
      ],
    );
    assert.equal(await repo.sumCostByTaskRun("tsk_cost"), 0.4);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
