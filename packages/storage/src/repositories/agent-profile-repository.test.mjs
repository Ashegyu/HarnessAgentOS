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
  "Ruflo Architecture Designer",
  "Agno Trace Planner",
  "Agno Product PRD Strategist",
  "Agno API Contract Architect",
  "Hermes Skill Curator",
  "Hermes Image Prompt Designer",
  "Codex Bulk Coder",
  "Codex Frontend Implementer",
  "ECC Refactor Cleaner",
  "ECC TDD Guide",
  "ECC Build Error Resolver",
  "ECC Security Reviewer",
  "C# Performance Reviewer",
  "ECC UX Flow Designer",
  "ECC Design QA Reviewer",
  "ECC Documentation Writer",
  "HTML Report Documenter",
  "ECC Data Migration Planner",
  "ECC Codebase Explorer",
  "ECC Docs Researcher",
  "Ruflo Federation Auditor",
  "Agno Runtime Service Architect",
  "Agno Approval Policy Designer",
  "Hermes Delegation Coordinator",
  "Hermes Memory Lifecycle Curator",
  "ECC Eval Harness Designer",
  "Harness IPC Contract Guardian",
  "Harness Storage Migration Steward",
  "Project PRD Agent",
  "Project Architecture Agent",
  "Project Plan Agent",
  "3D Texture Asset Generator",
  "3D Model Builder",
  "Project File Composer",
  "Class Skeleton Builder",
  "3D Integration Implementer",
  "Project Review Agent",
  "Execution Verification Agent",
  "Project Explanation Agent",
  "Completion Gate Reviewer",
];

const EXPECTED_SEED_COUNT = 4 + FRAMEWORK_PROFILE_NAMES.length;
const EXPECTED_ROLE_SET = [
  "build-error-resolver",
  "coder",
  "documenter",
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
  ["Ruflo Architecture Designer", "orchestrator"],
  ["Agno Trace Planner", "orchestrator"],
  ["Agno Product PRD Strategist", "planner"],
  ["Agno API Contract Architect", "planner"],
  ["Hermes Skill Curator", "planner"],
  ["Hermes Image Prompt Designer", "planner"],
  ["Codex Bulk Coder", "coder"],
  ["Codex Frontend Implementer", "coder"],
  ["ECC Refactor Cleaner", "refactor-cleaner"],
  ["ECC TDD Guide", "tester"],
  ["ECC Build Error Resolver", "build-error-resolver"],
  ["ECC Security Reviewer", "security-reviewer"],
  ["C# Performance Reviewer", "performance-reviewer"],
  ["ECC UX Flow Designer", "planner"],
  ["ECC Design QA Reviewer", "reviewer"],
  ["ECC Documentation Writer", "planner"],
  ["HTML Report Documenter", "documenter"],
  ["ECC Data Migration Planner", "planner"],
  ["ECC Codebase Explorer", "planner"],
  ["ECC Docs Researcher", "planner"],
  ["Ruflo Federation Auditor", "security-reviewer"],
  ["Agno Runtime Service Architect", "orchestrator"],
  ["Agno Approval Policy Designer", "security-reviewer"],
  ["Hermes Delegation Coordinator", "orchestrator"],
  ["Hermes Memory Lifecycle Curator", "planner"],
  ["ECC Eval Harness Designer", "tester"],
  ["Harness IPC Contract Guardian", "reviewer"],
  ["Harness Storage Migration Steward", "planner"],
  ["Project PRD Agent", "planner"],
  ["Project Architecture Agent", "orchestrator"],
  ["Project Plan Agent", "planner"],
  ["3D Texture Asset Generator", "coder"],
  ["3D Model Builder", "coder"],
  ["Project File Composer", "coder"],
  ["Class Skeleton Builder", "coder"],
  ["3D Integration Implementer", "coder"],
  ["Project Review Agent", "reviewer"],
  ["Execution Verification Agent", "tester"],
  ["Project Explanation Agent", "planner"],
  ["Completion Gate Reviewer", "reviewer"],
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
    assert.ok(all.every((p) => p.provider === "codex"), "all seed profiles run on Codex");
    assert.ok(
      all.every((p) => p.tuning.model === DEFAULT_CODEX_MODEL),
      "all seed profiles use the supported Codex default model",
    );
    assert.ok(
      all.every((p) => p.tuning.reasoningEffort === "xhigh"),
      "all seed profiles default to explicit Codex xhigh effort",
    );
    assert.ok(
      all.every(
        (p) =>
          p.permissions.toolAllowlist.length === 0 &&
          p.permissions.toolDenylist.length === 0,
      ),
      "Codex seed profiles must not carry unsupported provider tool policies",
    );
    assert.ok(
      all.every((p) => p.tuning.systemPromptPrefix.includes("HarnessAgentOS")),
      "all seed profiles carry the Harness project contract in the prompt prefix",
    );
    assert.ok(
      all.every((p) => p.tuning.systemPromptPrefix.includes("questions field as []")),
      "all seed profiles carry the no-questions contract in the prompt prefix",
    );
    assert.ok(
      all.every((p) => p.tuning.systemPromptPrefix.includes("file_write.after")),
      "all seed profiles must explain that file_write.after is complete replacement content",
    );
    assert.ok(
      all.every((p) => p.tuning.systemPromptSuffix.includes("보고")),
      "all seed profiles carry a concrete reporting contract in the prompt suffix",
    );
    assert.ok(all.some((p) => p.name === "ECC Security Reviewer" && p.tags.includes("security")));
    assert.ok(all.some((p) => p.name === "Agno Product PRD Strategist" && p.tags.includes("prd")));
    assert.ok(all.some((p) => p.name === "Ruflo Architecture Designer" && p.tags.includes("architecture")));
    assert.ok(all.some((p) => p.name === "Hermes Image Prompt Designer" && p.tags.includes("image")));
    assert.ok(all.some((p) => p.name === "ECC UX Flow Designer" && p.tags.includes("design")));
    assert.ok(all.some((p) => p.name === "ECC Codebase Explorer" && p.tags.includes("evidence")));
    assert.ok(all.some((p) => p.name === "HTML Report Documenter" && p.tags.includes("html")));
    assert.ok(all.some((p) => p.name === "Hermes Delegation Coordinator" && p.tags.includes("delegation")));
    assert.ok(all.some((p) => p.name === "Agno Approval Policy Designer" && p.tags.includes("approval")));
    assert.ok(all.some((p) => p.name === "Project PRD Agent" && p.tags.includes("prd")));
    assert.ok(all.some((p) => p.name === "Project Architecture Agent" && p.tags.includes("architecture")));
    assert.ok(all.some((p) => p.name === "Project Plan Agent" && p.tags.includes("project-plan")));
    assert.ok(all.some((p) => p.name === "3D Texture Asset Generator" && p.tags.includes("texture")));
    assert.ok(all.some((p) => p.name === "3D Model Builder" && p.tags.includes("3d-model")));
    assert.ok(all.some((p) => p.name === "3D Integration Implementer" && p.tags.includes("3d-integration")));
    assert.ok(all.some((p) => p.name === "Project Review Agent" && p.tags.includes("review")));
    assert.ok(all.some((p) => p.name === "Project Explanation Agent" && p.tags.includes("documentation")));
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
    assert.match(
      all.find((p) => p.name === "HTML Report Documenter")?.tuning.systemPromptSuffix ?? "",
      /docs\/harness-agent-report\.html|완전한 HTML5 문서/,
      "HTML documenter should carry the HTML file_write prompt contract",
    );
    assertFrameworkProfilesPresent(all);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed clears unsupported tool policies on existing Codex seed profiles", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const bulkCoder = await repo.create(
      makeProfileInput({
        name: "Codex Bulk Coder",
        role: "coder",
        provider: "claude",
        permissions: {
          autoApproveActions: [],
          blockedActions: [
            "dependency_install",
            "git_commit",
            "network",
            "skill_script",
          ],
          allowedSkillIds: ["ss_keep"],
          toolAllowlist: ["Read"],
          toolDenylist: ["Bash(*)"],
          budget: {
            perInvocationUsd: 0.15,
            perTaskRunUsd: 0.75,
          },
        },
      }),
    );

    await repo.ensureSeed();

    const refreshed = await repo.get(bulkCoder.id);
    assert.equal(refreshed.provider, "codex");
    assert.deepEqual(refreshed.permissions.toolAllowlist, []);
    assert.deepEqual(refreshed.permissions.toolDenylist, []);
    assert.deepEqual(refreshed.permissions.allowedSkillIds, ["ss_keep"]);
    assert.deepEqual(refreshed.permissions.blockedActions, [
      "dependency_install",
      "git_commit",
      "network",
      "skill_script",
    ]);
    assert.deepEqual(refreshed.permissions.budget, {
      perInvocationUsd: 0.15,
      perTaskRunUsd: 0.75,
    });
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed upgrades existing seed profiles to Codex", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const planner = await repo.create(
      makeProfileInput({
        name: "Planner",
        role: "planner",
        provider: "claude",
        tuning: {
          model: "claude-sonnet-4",
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
          contextDepth: 5,
          systemPromptPrefix: "keep-prefix",
          systemPromptSuffix: "keep-suffix",
        },
        isDefault: true,
      }),
    );
    const tdd = await repo.create(
      makeProfileInput({
        name: "ECC TDD Guide",
        role: "tester",
        provider: "claude",
        tuning: {
          model: "claude-sonnet-4",
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
          contextDepth: 5,
          systemPromptPrefix: "keep-tdd-prefix",
          systemPromptSuffix: "keep-tdd-suffix",
        },
      }),
    );

    await repo.ensureSeed();

    const refreshedPlanner = await repo.get(planner.id);
    const refreshedTdd = await repo.get(tdd.id);
    assert.equal(refreshedPlanner.provider, "codex");
    assert.equal(refreshedPlanner.tuning.model, DEFAULT_CODEX_MODEL);
    assert.equal(refreshedPlanner.tuning.reasoningEffort, "xhigh");
    assert.equal(refreshedPlanner.tuning.systemPromptPrefix, "keep-prefix");
    assert.equal(refreshedTdd.provider, "codex");
    assert.equal(refreshedTdd.tuning.model, DEFAULT_CODEX_MODEL);
    assert.equal(refreshedTdd.tuning.reasoningEffort, "xhigh");
    assert.equal(refreshedTdd.tuning.systemPromptPrefix, "keep-tdd-prefix");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed backfills empty rich prompt contracts on seed profiles", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const planner = await repo.create(
      makeProfileInput({
        name: "Planner",
        role: "planner",
        provider: "codex",
        tuning: {
          model: DEFAULT_CODEX_MODEL,
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
          contextDepth: 10,
          systemPromptPrefix: "",
          systemPromptSuffix: "",
        },
        isDefault: true,
      }),
    );

    await repo.ensureSeed();
    const refreshed = await repo.get(planner.id);

    assert.match(refreshed.tuning.systemPromptPrefix, /HarnessAgentOS/);
    assert.match(refreshed.tuning.systemPromptPrefix, /SQLite WAL/);
    assert.match(refreshed.tuning.systemPromptSuffix, /Planner/);
    assert.match(refreshed.tuning.systemPromptSuffix, /보고/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("AgentProfileRepository.ensureSeed preserves custom rich prompt contracts", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    const planner = await repo.create(
      makeProfileInput({
        name: "Planner",
        role: "planner",
        provider: "codex",
        tuning: {
          model: DEFAULT_CODEX_MODEL,
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
          stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
          contextDepth: 10,
          systemPromptPrefix: "CUSTOM PREFIX",
          systemPromptSuffix: "CUSTOM SUFFIX",
        },
        isDefault: true,
      }),
    );

    await repo.ensureSeed();
    const refreshed = await repo.get(planner.id);

    assert.equal(refreshed.tuning.systemPromptPrefix, "CUSTOM PREFIX");
    assert.equal(refreshed.tuning.systemPromptSuffix, "CUSTOM SUFFIX");
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
