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
import { AGENT_REASONING_EFFORTS } from "./codex-models.ts";

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
    "file_patch",
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

test("isAgentPermissions accepts optional budget caps", () => {
  assert.equal(
    isAgentPermissions({
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
    }),
    true,
  );
});

test("isAgentPermissions rejects malformed budget caps", () => {
  assert.equal(
    isAgentPermissions({
      autoApproveActions: [],
      blockedActions: [],
      allowedSkillIds: [],
      toolAllowlist: [],
      toolDenylist: [],
      budget: {
        perInvocationUsd: "0.05",
      },
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
      model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
      timeoutMs: 300_000,
      // stallTimeoutMs missing
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    false,
  );
});

test("isAgentModelTuning allows optional temperature/maxTokens/reasoning effort", () => {
  assert.deepEqual([...AGENT_REASONING_EFFORTS], [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(
    isAgentModelTuning({
      model: "gpt-5.6-terra",
      temperature: 0.2,
      maxTokens: 4096,
      reasoningEffort: "xhigh",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    true,
  );
});

test("isAgentProfile accepts Codex only", () => {
  const profile = {
    id: "ap_codex_only",
    name: "Codex only",
    description: "",
    category: "core",
    tags: [],
    provider: "claude",
    role: "coder",
    persona: "",
    tuning: {
      model: "gpt-5.6-sol",
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
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };

  assert.equal(isAgentProfile(profile), false);
  assert.equal(isAgentProfile({ ...profile, provider: "auto" }), false);
  assert.equal(isAgentProfile({ ...profile, provider: "codex" }), true);
});

test("isAgentModelTuning rejects unknown reasoning effort", () => {
  assert.equal(
    isAgentModelTuning({
      model: "gpt-5.6-sol",
      reasoningEffort: "turbo",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    }),
    false,
  );
});

test("isAgentProfile validates a complete profile with expanded role", () => {
  const profile = {
    id: "ap_test12345678",
    name: "Reviewer Codex",
    description: "",
    category: "security",
    tags: ["review", "security"],
    provider: "codex",
    role: "security-reviewer",
    persona: "You are a security reviewer.",
    tuning: {
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
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
  assert.equal(isAgentProfile({ ...profile, role: "documenter" }), true);
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
    provider: "codex",
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
    provider: "codex",
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
