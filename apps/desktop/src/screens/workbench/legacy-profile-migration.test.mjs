import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
} from "@harness/core";
import { planLegacyMigration } from "./legacy-profile-migration.ts";

const legacyAgentDefaults = {
  provider: "auto",
  model: "",
  timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
  contextDepth: 5,
};

const wp = (overrides = {}) => ({
  id: "wp_1",
  name: "Worker 1",
  provider: "claude",
  model: "claude-sonnet-4",
  role: "coder",
  ...overrides,
});

const existingProfile = (overrides = {}) => ({
  id: "ap_existing",
  name: "Existing",
  description: "",
  provider: "claude",
  role: "coder",
  persona: "",
  tuning: {
    model: "x",
    timeoutMs: 1,
    stallTimeoutMs: 1,
    contextDepth: 1,
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("planLegacyMigration returns null when AgentProfile rows already exist", () => {
  const plan = planLegacyMigration({
    legacyAgent: legacyAgentDefaults,
    workerProfiles: [wp()],
    existingProfiles: [existingProfile()],
  });
  // Never overwrite hand-tuned data.
  assert.equal(plan, null);
});

test("planLegacyMigration returns null when nothing legacy exists either", () => {
  const plan = planLegacyMigration({
    legacyAgent: legacyAgentDefaults,
    workerProfiles: [],
    existingProfiles: [],
  });
  assert.equal(plan, null);
});

test("planLegacyMigration produces one input per worker, first marked default", () => {
  const plan = planLegacyMigration({
    legacyAgent: { ...legacyAgentDefaults, timeoutMs: 600_000 },
    workerProfiles: [
      wp({ id: "wp_1", name: "Planner", role: "planner" }),
      wp({ id: "wp_2", name: "Coder", role: "coder" }),
    ],
    existingProfiles: [],
  });
  assert.ok(plan);
  assert.equal(plan.inputs.length, 2);
  assert.equal(plan.inputs[0].name, "Planner");
  assert.equal(plan.inputs[0].isDefault, true);
  assert.equal(plan.inputs[1].isDefault, false);
  // Tuning inherits the legacy global timeouts.
  assert.equal(plan.inputs[0].tuning.timeoutMs, 600_000);
});

test("planLegacyMigration falls back to a single seed when only legacy globals exist", () => {
  const plan = planLegacyMigration({
    legacyAgent: {
      ...legacyAgentDefaults,
      provider: "claude",
      model: "claude-sonnet-4",
    },
    workerProfiles: [],
    existingProfiles: [],
  });
  assert.ok(plan);
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.inputs[0].isDefault, true);
  assert.equal(plan.inputs[0].tuning.model, "claude-sonnet-4");
  assert.equal(plan.inputs[0].provider, "claude");
});

test("planLegacyMigration ignores pristine global defaults (nothing to migrate)", () => {
  // User never touched settings → no point flashing a migration banner.
  const plan = planLegacyMigration({
    legacyAgent: legacyAgentDefaults,
    workerProfiles: [],
    existingProfiles: [],
  });
  assert.equal(plan, null);
});

test("planLegacyMigration treats a non-default timeout as 'something to migrate'", () => {
  const plan = planLegacyMigration({
    legacyAgent: { ...legacyAgentDefaults, timeoutMs: DEFAULT_AGENT_TIMEOUT_MS + 60_000 },
    workerProfiles: [],
    existingProfiles: [],
  });
  assert.ok(plan);
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.inputs[0].tuning.timeoutMs, DEFAULT_AGENT_TIMEOUT_MS + 60_000);
});
