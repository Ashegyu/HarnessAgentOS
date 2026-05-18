import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftFromProfile,
  emptyDraft,
  serializeDraft,
  validateDraft,
} from "./agent-profile-form.ts";

const SAMPLE_PROFILE = {
  id: "ap_test",
  name: "Reviewer Claude",
  description: "PR security reviewer",
  category: "security",
  tags: ["review", "security", "review"],
  provider: "claude",
  role: "reviewer",
  persona: "PERSONA",
  tuning: {
    model: "claude-sonnet-4",
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 600_000,
    stallTimeoutMs: 90_000,
    contextDepth: 7,
    systemPromptPrefix: "PREFIX",
    systemPromptSuffix: "SUFFIX",
  },
  cli: {
    cliPathOverride: "/usr/local/bin/claude",
    env: {},
    envSecretRefs: {},
  },
  permissions: {
    autoApproveActions: ["file_write"],
    blockedActions: ["git_commit"],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
    budget: {
      perInvocationUsd: 0.05,
      perTaskRunUsd: 0.25,
      perDayUsd: 1,
    },
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

test("emptyDraft has reasonable defaults that pass validation immediately", () => {
  const d = emptyDraft();
  d.name = "Required"; // empty name is the only required field
  const errors = validateDraft(d);
  assert.deepEqual(errors, []);
});

test("validateDraft rejects empty name", () => {
  const d = emptyDraft();
  d.name = "";
  const errors = validateDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validateDraft rejects non-numeric timeout", () => {
  const d = emptyDraft();
  d.name = "X";
  d.timeoutMsText = "abc";
  const errors = validateDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "timeoutMsText");
});

test("validateDraft accepts empty optional temperature/maxTokens", () => {
  const d = emptyDraft();
  d.name = "X";
  d.temperatureText = "";
  d.maxTokensText = "";
  const errors = validateDraft(d);
  assert.deepEqual(errors, []);
});

test("validateDraft rejects temperature outside 0-2", () => {
  const d = emptyDraft();
  d.name = "X";
  d.temperatureText = "3.5";
  const errors = validateDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "temperatureText");
});

test("draftFromProfile populates permissionMap from auto/block lists", () => {
  const d = draftFromProfile(SAMPLE_PROFILE);
  assert.equal(d.permissionMap.file_write, "auto");
  assert.equal(d.permissionMap.git_commit, "block");
  assert.equal(d.permissionMap.shell, "default");
  // Other tuning fields round-trip into text inputs
  assert.equal(d.temperatureText, "0.2");
  assert.equal(d.maxTokensText, "4096");
  assert.equal(d.systemPromptPrefix, "PREFIX");
  assert.equal(d.category, "security");
  assert.equal(d.tagsText, "review, security, review");
  assert.equal(d.perInvocationUsdText, "0.05");
  assert.equal(d.perTaskRunUsdText, "0.25");
  assert.equal(d.perDayUsdText, "1");
});

test("draftFromProfile → serializeDraft is a faithful round-trip", () => {
  const d = draftFromProfile(SAMPLE_PROFILE);
  const out = serializeDraft(d);
  assert.equal(out.id, SAMPLE_PROFILE.id);
  assert.equal(out.name, SAMPLE_PROFILE.name);
  assert.equal(out.category, "security");
  assert.deepEqual(out.tags, ["review", "security"]);
  assert.equal(out.persona, SAMPLE_PROFILE.persona);
  assert.equal(out.tuning.model, SAMPLE_PROFILE.tuning.model);
  assert.equal(out.tuning.temperature, 0.2);
  assert.equal(out.tuning.maxTokens, 4096);
  assert.equal(out.tuning.systemPromptPrefix, "PREFIX");
  assert.deepEqual(out.permissions.autoApproveActions, ["file_write"]);
  assert.deepEqual(out.permissions.blockedActions, ["git_commit"]);
  assert.deepEqual(out.permissions.budget, {
    perInvocationUsd: 0.05,
    perTaskRunUsd: 0.25,
    perDayUsd: 1,
  });
  assert.equal(out.cli.cliPathOverride, "/usr/local/bin/claude");
  assert.equal(out.isDefault, true);
});

test("serializeDraft omits temperature/maxTokens when their text is empty", () => {
  const d = emptyDraft();
  d.name = "X";
  // Both empty by default
  const out = serializeDraft(d);
  assert.equal(out.tuning.temperature, undefined);
  assert.equal(out.tuning.maxTokens, undefined);
});

test("validateDraft rejects malformed optional budget fields", () => {
  const d = emptyDraft();
  d.name = "X";
  d.perInvocationUsdText = "abc";
  const errors = validateDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "perInvocationUsdText");
});

test("serializeDraft omits budget when all budget fields are empty", () => {
  const d = emptyDraft();
  d.name = "No budget";
  const out = serializeDraft(d);
  assert.equal(out.permissions.budget, undefined);
});

test("serializeDraft handles a brand-new draft (id stays placeholder)", () => {
  const d = emptyDraft();
  d.name = "Brand new";
  d.persona = "test persona";
  const out = serializeDraft(d);
  assert.equal(out.id, "ap_placeholder");
  assert.equal(out.name, "Brand new");
  assert.equal(out.category, "core");
  assert.deepEqual(out.tags, []);
  assert.equal(out.persona, "test persona");
});

test("serializeDraft normalizes comma-separated tags", () => {
  const d = emptyDraft();
  d.name = "Tagged";
  d.category = "Review";
  d.tagsText = "Security, review, security,  dotnet ";
  const out = serializeDraft(d);
  assert.equal(out.category, "review");
  assert.deepEqual(out.tags, ["security", "review", "dotnet"]);
});
