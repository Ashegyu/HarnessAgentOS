import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_PERMISSIONS,
  AGENT_PROFILE_ACTION_TYPES,
  isAgentProfile,
  isAgentPermissions,
  isAgentModelTuning,
  isAgentCliEnv,
} from "./agent-profile.ts";

test("DEFAULT_AGENT_PERMISSIONS is frozen with empty arrays", () => {
  assert.ok(Object.isFrozen(DEFAULT_AGENT_PERMISSIONS));
  assert.deepEqual(DEFAULT_AGENT_PERMISSIONS.autoApproveActions, []);
  assert.deepEqual(DEFAULT_AGENT_PERMISSIONS.blockedActions, []);
  assert.deepEqual(DEFAULT_AGENT_PERMISSIONS.allowedSkillIds, []);
  assert.deepEqual(DEFAULT_AGENT_PERMISSIONS.toolAllowlist, []);
  assert.deepEqual(DEFAULT_AGENT_PERMISSIONS.toolDenylist, []);
});

test("AGENT_PROFILE_ACTION_TYPES matches the approval action types", () => {
  // Must mirror APPROVAL_ACTION_TYPES so permission UI never references
  // an action that the approval system doesn't know about.
  assert.deepEqual([...AGENT_PROFILE_ACTION_TYPES].sort(), [
    "capability_use",
    "dependency_install",
    "file_write",
    "git_commit",
    "model_use",
    "network",
    "orchestration_plan",
    "shell",
    "skill_script",
  ]);
});

test("isAgentPermissions accepts a well-formed permissions object", () => {
  assert.equal(
    isAgentPermissions({
      autoApproveActions: ["file_write"],
      blockedActions: [],
      allowedSkillIds: ["skill-a"],
      toolAllowlist: ["foo:*"],
      toolDenylist: [],
    }),
    true,
  );
});

test("isAgentPermissions rejects missing arrays", () => {
  assert.equal(isAgentPermissions({}), false);
  assert.equal(
    isAgentPermissions({
      autoApproveActions: [],
      blockedActions: [],
      allowedSkillIds: [],
      toolAllowlist: [],
      // toolDenylist missing
    }),
    false,
  );
});

test("isAgentPermissions rejects unknown action type", () => {
  assert.equal(
    isAgentPermissions({
      autoApproveActions: ["explode_the_machine"],
      blockedActions: [],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
    }),
    false,
  );
});

test("isAgentCliEnv accepts empty env maps", () => {
  assert.equal(
    isAgentCliEnv({ cliPathOverride: "", env: {}, envSecretRefs: {} }),
    true,
  );
});

test("isAgentCliEnv rejects non-string env values", () => {
  assert.equal(
    isAgentCliEnv({
      cliPathOverride: "",
      env: { FOO: 42 },
      envSecretRefs: {},
    }),
    false,
  );
});

test("isAgentModelTuning requires the budget fields", () => {
  assert.equal(
    isAgentModelTuning({
      model: "claude-sonnet-4",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    true,
  );
  assert.equal(
    isAgentModelTuning({
      model: "claude-sonnet-4",
      timeoutMs: 300_000,
      // stallTimeoutMs missing
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    false,
  );
});

test("isAgentModelTuning allows optional temperature/maxTokens", () => {
  assert.equal(
    isAgentModelTuning({
      model: "claude-sonnet-4",
      temperature: 0.2,
      maxTokens: 4096,
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    true,
  );
});

test("isAgentProfile validates a complete profile", () => {
  const profile = {
    id: "ap_test12345678",
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
    isDefault: true,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isAgentProfile(profile), true);
});

test("isAgentProfile rejects unknown provider", () => {
  const profile = {
    id: "ap_test12345678",
    name: "Bogus",
    description: "",
    category: "core",
    tags: [],
    provider: "openai",
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
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isAgentProfile(profile), false);
});

test("isAgentProfile rejects unknown role", () => {
  const profile = {
    id: "ap_test12345678",
    name: "Bogus",
    description: "",
    category: "core",
    tags: [],
    provider: "claude",
    role: "destroyer",
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
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isAgentProfile(profile), false);
});

test("isAgentProfile rejects missing taxonomy", () => {
  const profile = {
    id: "ap_test12345678",
    name: "Bogus",
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
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isAgentProfile(profile), false);
});
