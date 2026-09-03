import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentProfile } from "./agent-profile-resolver.ts";

const legacyAgent = {
  provider: "codex",
  model: "gpt-5.6-sol",
  timeoutMs: 300_000,
  stallTimeoutMs: 60_000,
  contextDepth: 5,
};

const makeProfile = (overrides = {}) => ({
  id: "ap_x",
  name: "X",
  description: "",
  provider: "codex",
  role: "coder",
  persona: "",
  tuning: {
    model: "gpt-5.6-terra",
    timeoutMs: 600_000,
    stallTimeoutMs: 90_000,
    contextDepth: 7,
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
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  ...overrides,
});

test("resolveAgentProfile picks the activeAgentProfileId when set", () => {
  const profileA = makeProfile({ id: "ap_a", isDefault: true });
  const profileB = makeProfile({ id: "ap_b", name: "B" });
  const out = resolveAgentProfile({
    profiles: [profileA, profileB],
    activeAgentProfileId: "ap_b",
    legacyAgent,
  });
  assert.equal(out.source, "active");
  assert.equal(out.profile?.id, "ap_b");
});

test("resolveAgentProfile falls back to isDefault when active is missing", () => {
  const profileA = makeProfile({ id: "ap_a", isDefault: true });
  const profileB = makeProfile({ id: "ap_b", name: "B" });
  const out = resolveAgentProfile({
    profiles: [profileA, profileB],
    activeAgentProfileId: undefined,
    legacyAgent,
  });
  assert.equal(out.source, "default");
  assert.equal(out.profile?.id, "ap_a");
});

test("resolveAgentProfile falls back to legacy when no profile rows exist", () => {
  const out = resolveAgentProfile({
    profiles: [],
    activeAgentProfileId: undefined,
    legacyAgent,
  });
  assert.equal(out.source, "legacy");
  assert.equal(out.profile, null);
  assert.equal(out.tuning.model, "gpt-5.6-sol");
  assert.equal(out.tuning.timeoutMs, 300_000);
});

test("resolveAgentProfile falls back to legacy when active id is unknown", () => {
  // An invalid activeAgentProfileId (stale row deleted etc.) must not
  // hang the system — fall through to isDefault, then to legacy.
  const out = resolveAgentProfile({
    profiles: [makeProfile({ id: "ap_a" })],
    activeAgentProfileId: "ap_missing",
    legacyAgent,
  });
  // No isDefault profile exists (ap_a has isDefault: false), so legacy.
  assert.equal(out.source, "legacy");
  assert.equal(out.profile, null);
});

test("resolveAgentProfile surfaces profile tuning when a profile wins", () => {
  const profile = makeProfile({ id: "ap_a", isDefault: true });
  const out = resolveAgentProfile({
    profiles: [profile],
    activeAgentProfileId: undefined,
    legacyAgent,
  });
  assert.equal(out.tuning.model, "gpt-5.6-terra");
  assert.equal(out.tuning.timeoutMs, 600_000);
  assert.equal(out.tuning.stallTimeoutMs, 90_000);
});

test("resolveAgentProfile exposes persona and prefix/suffix from the winning profile", () => {
  const profile = makeProfile({
    id: "ap_a",
    isDefault: true,
    persona: "PERSONA TEXT",
    tuning: {
      model: "m",
      timeoutMs: 1,
      stallTimeoutMs: 1,
      contextDepth: 1,
      systemPromptPrefix: "PREFIX",
      systemPromptSuffix: "SUFFIX",
    },
  });
  const out = resolveAgentProfile({
    profiles: [profile],
    activeAgentProfileId: undefined,
    legacyAgent,
  });
  assert.equal(out.persona, "PERSONA TEXT");
  assert.equal(out.systemPromptPrefix, "PREFIX");
  assert.equal(out.systemPromptSuffix, "SUFFIX");
});

test("resolveAgentProfile leaves persona empty in legacy fallback", () => {
  const out = resolveAgentProfile({
    profiles: [],
    activeAgentProfileId: undefined,
    legacyAgent,
  });
  assert.equal(out.persona, "");
  assert.equal(out.systemPromptPrefix, "");
  assert.equal(out.systemPromptSuffix, "");
});
