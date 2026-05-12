import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, SqliteAgentProfileRepository } from "@harness/storage";
import { buildAgentsHandlers } from "./agents-ipc.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-agents-ipc-"));
  return {
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeProfileInput = (overrides = {}) => ({
  name: "Reviewer",
  description: "",
  provider: "claude",
  role: "reviewer",
  persona: "",
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

const setupCtx = (file) => {
  const db = openDb({ filePath: file });
  const profiles = new SqliteAgentProfileRepository(db);
  // The IPC handlers need a settings stub that supports get/update because
  // setActive writes activeAgentProfileId. Keep it minimal.
  let stored = { agent: { provider: "auto", model: "", timeoutMs: 300_000, stallTimeoutMs: 60_000, contextDepth: 5 }, orchestration: { enabled: false, defaultMode: "single_worker", defaultInstructions: "", workerProfiles: [] }, approval: { autoApprove: false } };
  const state = {
    profiles,
    getSettings: async () => structuredClone(stored),
    updateSettings: async (next) => {
      stored = structuredClone(next);
      return structuredClone(stored);
    },
  };
  return { db, state };
};

test("agents.list returns an ok-wrapped empty array on a fresh DB", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const result = await h.list();
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.create returns the created profile and persists it", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const created = await h.create({ profile: makeProfileInput() });
    assert.equal(created.ok, true);
    assert.ok(created.value.id.startsWith("ap_"));
    const list = await h.list();
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].id, created.value.id);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.create rejects malformed input with STATE_INVALID_INPUT", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const bad = await h.create({ profile: { ...makeProfileInput(), provider: "openai" } });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "STATE_INVALID_INPUT");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.update returns NOT_FOUND when the profile id is unknown", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const bogus = {
      ...makeProfileInput(),
      id: "ap_does_not_exist",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await h.update({ profile: bogus });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "AGENT_PROFILE_NOT_FOUND");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.setDefault demotes the previous default", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const a = (await h.create({ profile: makeProfileInput({ name: "A", isDefault: true }) })).value;
    const b = (await h.create({ profile: makeProfileInput({ name: "B" }) })).value;
    const promoted = await h.setDefault({ profileId: b.id });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.value.isDefault, true);
    const all = (await h.list()).value;
    const old = all.find((p) => p.id === a.id);
    assert.equal(old.isDefault, false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.setActive writes activeAgentProfileId into HarnessSettings", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const a = (await h.create({ profile: makeProfileInput({ name: "A" }) })).value;
    const result = await h.setActive({ profileId: a.id });
    assert.equal(result.ok, true);
    assert.equal(result.value.activeAgentProfileId, a.id);
    // Clearing the active profile is permitted via profileId: null.
    const cleared = await h.setActive({ profileId: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.activeAgentProfileId, undefined);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("agents.delete removes the row", async () => {
  const t = tmp();
  const { db, state } = setupCtx(t.file);
  try {
    const h = buildAgentsHandlers({ state });
    const a = (await h.create({ profile: makeProfileInput({ name: "A" }) })).value;
    const result = await h.delete({ profileId: a.id });
    assert.equal(result.ok, true);
    const list = (await h.list()).value;
    assert.equal(list.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
