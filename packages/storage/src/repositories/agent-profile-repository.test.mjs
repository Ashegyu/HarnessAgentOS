import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db.ts";
import { SqliteAgentProfileRepository } from "./agent-profile-repository.ts";

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

test("AgentProfileRepository.ensureSeed inserts 4 profiles on empty DB", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  try {
    const repo = new SqliteAgentProfileRepository(db);
    assert.deepEqual(await repo.list(), [], "pre-condition: table is empty");
    await repo.ensureSeed();
    const all = await repo.list();
    assert.equal(all.length, 4, "must seed exactly 4 profiles");
    const roles = all.map((p) => p.role).sort();
    assert.deepEqual(roles, ["coder", "planner", "reviewer", "tester"]);
    const defaults = all.filter((p) => p.isDefault);
    assert.equal(defaults.length, 1, "exactly one profile must be isDefault");
    assert.equal(defaults[0].role, "planner", "planner is the default");
    assert.ok(all.every((p) => p.skillSourceIds.includes("ss_project")), "all profiles reference ss_project");
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
    assert.equal(all.length, 4, "second call must not insert duplicates");
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
    // Existing reviewer row + 3 newly-seeded (planner, coder, tester).
    assert.equal(all.length, 4, "ensureSeed fills the missing roles");
    const roles = all.map((p) => p.role).sort();
    assert.deepEqual(roles, ["coder", "planner", "reviewer", "tester"]);
    // The pre-existing row's id must survive — ensureSeed never
    // overwrites a role that's already present.
    const reviewerRows = all.filter((p) => p.role === "reviewer");
    assert.equal(reviewerRows.length, 1, "no duplicate reviewer row");
    assert.equal(reviewerRows[0].id, existing.id, "existing row preserved");
    assert.equal(reviewerRows[0].name, "Existing", "existing name preserved");
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
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
