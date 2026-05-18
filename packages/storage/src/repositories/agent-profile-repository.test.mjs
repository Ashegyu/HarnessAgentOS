import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteAgentProfileRepository } from "./agent-profile-repository.ts";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_CODEX_MODEL,
} from "@harness/core";

const FRAMEWORK_PROFILE_NAMES = [
  "Ruflo Orchestrator",
  "Agno Trace Planner",
  "Codex Bulk Coder",
  "ECC Refactor Cleaner",
  "ECC TDD Guide",
  "ECC Build Error Resolver",
  "ECC Security Reviewer",
  "C# Performance Reviewer",
];

const EXPECTED_SEED_COUNT = 4 + FRAMEWORK_PROFILE_NAMES.length;
const EXPECTED_ROLE_SET = [
  "build-error-resolver",
  "coder",
  "orchestrator",
  "performance-reviewer",
  "planner",
  "refactor-cleaner",
  "reviewer",
  "security-reviewer",
  "tester",
];
const FRAMEWORK_PROFILE_ROLES = new Map([
  ["Ruflo Orchestrator", "orchestrator"],
  ["Agno Trace Planner", "orchestrator"],
  ["Codex Bulk Coder", "coder"],
  ["ECC Refactor Cleaner", "refactor-cleaner"],
  ["ECC TDD Guide", "tester"],
  ["ECC Build Error Resolver", "build-error-resolver"],
  ["ECC Security Reviewer", "security-reviewer"],
  ["C# Performance Reviewer", "performance-reviewer"],
]);

const assertFrameworkProfilesPresent = (profiles) => {
  const byName = new Map(profiles.map((p) => [p.name, p]));
  for (const name of FRAMEWORK_PROFILE_NAMES) {
    const profile = byName.get(name);
    assert.ok(profile, `missing framework profile: ${name}`);
    assert.equal(
      profile.role,
      FRAMEWORK_PROFILE_ROLES.get(name),
      `unexpected framework role: ${name}`,
    );
  }
};

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-ap-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeProfileInput = (overrides = {}) => ({
  name: "Reviewer Claude",
  description: "",
  category: "security",
  tags: ["review", "security"],
  provider: "claude",
  role: "reviewer",
  persona: "You are a security reviewer.",
  tuning: {
    model: "claude-sonnet-4",
    timeoutMs: 300_000,
    stallTimeoutMs: 60_000,
    contextDepth: 5,
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

test("AgentProfileRepository.list returns [] on an empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    assert.deepEqual(await repo.list(), []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.create assigns an id and timestamps", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(makeProfileInput());
    assert.ok(created.id.startsWith("ap_"), `id should start with ap_: ${created.id}`);
    assert.ok(created.createdAt.length > 0);
    assert.equal(created.createdAt, created.updatedAt);
    const round = await repo.get(created.id);
    assert.deepEqual(round, created);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.update bumps updatedAt without changing createdAt", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(makeProfileInput());
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update({ ...created, name: "Renamed" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.name, "Renamed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.delete removes the row", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(makeProfileInput());
    await repo.delete(created.id);
    assert.equal(await repo.get(created.id), null);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.setDefault demotes the previous default atomically", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const a = await repo.create(makeProfileInput({ name: "A", isDefault: true }));
    const b = await repo.create(makeProfileInput({ name: "B", isDefault: false }));
    const promoted = await repo.setDefault(b.id);
    assert.equal(promoted.isDefault, true);
    const refreshedA = await repo.get(a.id);
    assert.equal(refreshedA.isDefault, false, "previous default must be demoted");
    // Exactly one row carries isDefault=true at all times.
    const list = await repo.list();
    assert.equal(list.filter((p) => p.isDefault).length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed inserts canonical and framework profiles on empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    assert.deepEqual(await repo.list(), [], "pre-condition: table is empty");
    await repo.ensureSeed();
    const all = await repo.list();
    assert.equal(all.length, EXPECTED_SEED_COUNT, "must seed canonical and framework profiles");
    const roles = [...new Set(all.map((p) => p.role))].sort();
    assert.deepEqual(roles, EXPECTED_ROLE_SET);
    const defaults = all.filter((p) => p.isDefault);
    assert.equal(defaults.length, 1, "exactly one profile must be isDefault");
    assert.equal(defaults[0].role, "planner", "planner is the default");
    assert.ok(all.every((p) => p.skillSourceIds.includes("ss_project")), "all profiles reference ss_project");
    assert.ok(all.every((p) => p.category.length > 0), "all profiles have a category");
    assert.ok(all.some((p) => p.name === "ECC Security Reviewer" && p.tags.includes("security")));
    assert.match(
      all.find((p) => p.name === "Planner")?.persona ?? "",
      /한국어|요구사항/,
      "seed persona should be Korean-facing",
    );
    assert.match(
      all.find((p) => p.name === "ECC Build Error Resolver")?.persona ?? "",
      /첫 번째 실제 실패|한국어/,
      "framework seed persona should be Korean-facing",
    );
    assertFrameworkProfilesPresent(all);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed is idempotent", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    await repo.ensureSeed();
    await repo.ensureSeed();
    const all = await repo.list();
    assert.equal(all.length, EXPECTED_SEED_COUNT, "second call must not insert duplicates");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed localizes unmodified English seed text", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const legacy = await repo.create(
      makeProfileInput({
        name: "Planner",
        role: "planner",
        description:
          "Strategic planning and task decomposition. Breaks complex requests into actionable steps and coordinates downstream agents.",
        persona:
          "You are a senior engineering lead specialising in requirement analysis and sprint planning. Your goal is to produce clear, unambiguous task breakdowns that a coding agent can implement without additional clarification.",
        isDefault: true,
      }),
    );

    await repo.ensureSeed();
    const refreshed = await repo.get(legacy.id);

    assert.match(refreshed.description, /실행 가능한 단계/);
    assert.match(refreshed.persona, /요구사항 분석/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed fills only the missing canonical roles", async () => {
  // ensureSeed's contract is "every canonical role has a row", not
  // "no-op when any row exists". A pre-existing row that already
  // covers one role must be preserved verbatim; the remaining 3 roles
  // are seeded around it. This matches the docstring on ensureSeed
  // and the migration path from legacy WorkerProfile rows.
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    // makeProfileInput defaults to role=reviewer.
    const existing = await repo.create(makeProfileInput({ name: "Existing" }));
    await repo.ensureSeed();
    const all = await repo.list();
    // Existing reviewer row + 3 canonical roles + framework profiles.
    assert.equal(all.length, EXPECTED_SEED_COUNT, "ensureSeed fills roles and framework profiles");
    const roles = [...new Set(all.map((p) => p.role))].sort();
    assert.deepEqual(roles, EXPECTED_ROLE_SET);
    // The pre-existing row's id must survive — ensureSeed never
    // overwrites a role that's already present.
    const existingRow = all.find((p) => p.id === existing.id);
    assert.ok(existingRow, "existing reviewer row preserved");
    assert.equal(existingRow.name, "Existing", "existing name preserved");
    assert.equal(all.some((p) => p.name === "Reviewer"), false, "canonical reviewer is not duplicated");
    assertFrameworkProfilesPresent(all);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed adds framework profiles when canonical roles already exist", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const existing = await Promise.all([
      repo.create(makeProfileInput({ name: "Existing Planner", role: "planner", isDefault: true })),
      repo.create(makeProfileInput({ name: "Existing Coder", role: "coder" })),
      repo.create(makeProfileInput({ name: "Existing Reviewer", role: "reviewer" })),
      repo.create(makeProfileInput({ name: "Existing Tester", role: "tester" })),
    ]);

    await repo.ensureSeed();
    const all = await repo.list();

    assert.equal(all.length, EXPECTED_SEED_COUNT, "framework profiles are added without canonical duplicates");
    for (const profile of existing) {
      assert.ok(all.some((p) => p.id === profile.id), `existing profile preserved: ${profile.name}`);
    }
    assert.equal(all.some((p) => p.name === "Planner"), false, "canonical planner is not duplicated");
    assert.equal(all.some((p) => p.name === "Coder"), false, "canonical coder is not duplicated");
    assert.equal(all.some((p) => p.name === "Reviewer"), false, "canonical reviewer is not duplicated");
    assert.equal(all.some((p) => p.name === "Tester"), false, "canonical tester is not duplicated");
    assertFrameworkProfilesPresent(all);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.create round-trips arrays and nested objects", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(
      makeProfileInput({
        mcpServerIds: ["mcp_a", "mcp_b"],
        skillSourceIds: ["ss_user"],
        permissions: {
          autoApproveActions: ["file_write"],
          blockedActions: ["network"],
          allowedSkillIds: ["skill-1"],
          toolAllowlist: ["fs:*"],
          toolDenylist: ["fs:rm"],
        },
        cli: {
          cliPathOverride: "/usr/local/bin/claude",
          env: { LOG: "info" },
          envSecretRefs: { ANTHROPIC_API_KEY: "anth_key" },
        },
        tuning: {
          model: "claude-sonnet-4",
          temperature: 0.2,
          maxTokens: 4096,
          timeoutMs: 300_000,
          stallTimeoutMs: 60_000,
          contextDepth: 5,
          systemPromptPrefix: "PREFIX",
          systemPromptSuffix: "SUFFIX",
        },
      }),
    );
    const fetched = await repo.get(created.id);
    assert.deepEqual(fetched.mcpServerIds, ["mcp_a", "mcp_b"]);
    assert.deepEqual(fetched.skillSourceIds, ["ss_user"]);
    assert.deepEqual(fetched.permissions.autoApproveActions, ["file_write"]);
    assert.equal(fetched.cli.envSecretRefs.ANTHROPIC_API_KEY, "anth_key");
    assert.equal(fetched.tuning.temperature, 0.2);
    assert.equal(fetched.tuning.systemPromptPrefix, "PREFIX");
    assert.equal(fetched.category, "security");
    assert.deepEqual(fetched.tags, ["review", "security"]);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository round-trips budget caps through budget_json", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(
      makeProfileInput({
        permissions: {
          autoApproveActions: ["model_use"],
          blockedActions: [],
          allowedSkillIds: [],
          toolAllowlist: [],
          toolDenylist: [],
          budget: {
            perInvocationUsd: 0.05,
            perTaskRunUsd: 0.25,
            perDayUsd: 1,
          },
        },
      }),
    );
    assert.deepEqual(created.permissions.budget, {
      perInvocationUsd: 0.05,
      perTaskRunUsd: 0.25,
      perDayUsd: 1,
    });
    const fetched = await repo.get(created.id);
    assert.deepEqual(fetched.permissions.budget, created.permissions.budget);
    const row = db
      .prepare(
        `SELECT permissions_json, budget_json FROM agent_profiles WHERE id = ?`,
      )
      .get(created.id);
    assert.equal(JSON.parse(row.permissions_json).budget, undefined);
    assert.deepEqual(JSON.parse(row.budget_json), created.permissions.budget);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.list upgrades legacy profile timeout values below defaults", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(
      makeProfileInput({
        name: "Legacy Planner",
        role: "planner",
        tuning: {
          model: "claude-sonnet-4",
          timeoutMs: 120_000,
          stallTimeoutMs: 30_000,
          contextDepth: 5,
          systemPromptPrefix: "",
          systemPromptSuffix: "",
        },
        isDefault: true,
      }),
    );
    db.prepare("UPDATE agent_profiles SET tuning_json = ? WHERE id = ?").run(
      JSON.stringify({
        model: "claude-sonnet-4",
        timeoutMs: 120_000,
        stallTimeoutMs: 30_000,
        contextDepth: 5,
        systemPromptPrefix: "",
        systemPromptSuffix: "",
      }),
      created.id,
    );

    const [profile] = await repo.list();
    assert.equal(profile.tuning.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
    assert.equal(profile.tuning.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS);

    const fetched = await repo.get(profile.id);
    assert.equal(fetched.tuning.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS);
    assert.equal(fetched.tuning.stallTimeoutMs, DEFAULT_AGENT_STALL_TIMEOUT_MS);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository upgrades unsupported legacy Codex gpt-5 model", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const created = await repo.create(
      makeProfileInput({
        name: "Codex Worker",
        provider: "codex",
        role: "coder",
        tuning: {
          model: "gpt-5",
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
          contextDepth: 5,
          systemPromptPrefix: "",
          systemPromptSuffix: "",
        },
      }),
    );

    assert.equal(created.tuning.model, DEFAULT_CODEX_MODEL);

    db.prepare("UPDATE agent_profiles SET tuning_json = ? WHERE id = ?").run(
      JSON.stringify({
        model: "gpt-5",
        timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
        contextDepth: 5,
        systemPromptPrefix: "",
        systemPromptSuffix: "",
      }),
      created.id,
    );

    const fetched = await repo.get(created.id);
    assert.equal(fetched.tuning.model, DEFAULT_CODEX_MODEL);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
