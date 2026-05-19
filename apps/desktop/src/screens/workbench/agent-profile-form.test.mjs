import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CODEX_MODEL } from "@harness/core";
import {
  buildBindingPolicyHints,
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
    reasoningEffort: "xhigh",
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
    allowedSkillIds: ["skill_review"],
    toolAllowlist: ["mcp__repo__read_*"],
    toolDenylist: ["mcp__repo__delete_*"],
    budget: {
      perInvocationUsd: 0.05,
      perTaskRunUsd: 0.25,
      perDayUsd: 1,
    },
  },
  mcpServerIds: ["mcp_repo"],
  skillSourceIds: ["ss_project"],
  isDefault: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
};

test("emptyDraft has reasonable defaults that pass validation immediately", () => {
  const d = emptyDraft();
  d.name = "Required"; // empty name is the only required field
  const errors = validateDraft(d);
  assert.deepEqual(errors, []);
  assert.equal(d.provider, "codex");
  assert.equal(d.model, DEFAULT_CODEX_MODEL);
  assert.equal(d.reasoningEffort, "xhigh");
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

test("validateDraft rejects unknown reasoning effort", () => {
  const d = emptyDraft();
  d.name = "X";
  d.reasoningEffort = "turbo";
  const errors = validateDraft(d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "reasoningEffort");
});

test("draftFromProfile populates permissionMap from auto/block lists", () => {
  const d = draftFromProfile(SAMPLE_PROFILE);
  assert.equal(d.permissionMap.file_write, "auto");
  assert.equal(d.permissionMap.git_commit, "block");
  assert.equal(d.permissionMap.shell, "default");
  // Other tuning fields round-trip into text inputs
  assert.equal(d.temperatureText, "0.2");
  assert.equal(d.maxTokensText, "4096");
  assert.equal(d.reasoningEffort, "xhigh");
  assert.equal(d.systemPromptPrefix, "PREFIX");
  assert.equal(d.category, "security");
  assert.equal(d.tagsText, "review, security, review");
  assert.equal(d.perInvocationUsdText, "0.05");
  assert.equal(d.perTaskRunUsdText, "0.25");
  assert.equal(d.perDayUsdText, "1");
  assert.equal(d.mcpServerIdsText, "mcp_repo");
  assert.equal(d.skillSourceIdsText, "ss_project");
  assert.equal(d.allowedSkillIdsText, "skill_review");
  assert.equal(d.toolAllowlistText, "mcp__repo__read_*");
  assert.equal(d.toolDenylistText, "mcp__repo__delete_*");
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
  assert.equal(out.tuning.reasoningEffort, "xhigh");
  assert.equal(out.tuning.systemPromptPrefix, "PREFIX");
  assert.deepEqual(out.permissions.autoApproveActions, ["file_write"]);
  assert.deepEqual(out.permissions.blockedActions, ["git_commit"]);
  assert.deepEqual(out.permissions.allowedSkillIds, ["skill_review"]);
  assert.deepEqual(out.permissions.toolAllowlist, ["mcp__repo__read_*"]);
  assert.deepEqual(out.permissions.toolDenylist, ["mcp__repo__delete_*"]);
  assert.deepEqual(out.permissions.budget, {
    perInvocationUsd: 0.05,
    perTaskRunUsd: 0.25,
    perDayUsd: 1,
  });
  assert.equal(out.cli.cliPathOverride, "/usr/local/bin/claude");
  assert.deepEqual(out.mcpServerIds, ["mcp_repo"]);
  assert.deepEqual(out.skillSourceIds, ["ss_project"]);
  assert.equal(out.isDefault, true);
});

test("serializeDraft normalizes capability binding lists without duplicates", () => {
  const d = emptyDraft();
  d.name = "Bound";
  d.mcpServerIdsText = "mcp_a, mcp_b\nmcp_a";
  d.skillSourceIdsText = "ss_project\nss_team";
  d.allowedSkillIdsText = "skill_review, skill_review, skill_test";
  d.toolAllowlistText = "mcp__repo__read_*\nmcp__repo__list_*";
  d.toolDenylistText = "mcp__repo__delete_*";

  const out = serializeDraft(d);
  assert.deepEqual(out.mcpServerIds, ["mcp_a", "mcp_b"]);
  assert.deepEqual(out.skillSourceIds, ["ss_project", "ss_team"]);
  assert.deepEqual(out.permissions.allowedSkillIds, [
    "skill_review",
    "skill_test",
  ]);
  assert.deepEqual(out.permissions.toolAllowlist, [
    "mcp__repo__read_*",
    "mcp__repo__list_*",
  ]);
  assert.deepEqual(out.permissions.toolDenylist, ["mcp__repo__delete_*"]);
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

test("buildBindingPolicyHints marks Codex MCP bindings as limited per-run support", () => {
  const d = emptyDraft();
  d.name = "Codex MCP";
  d.provider = "codex";
  d.mcpServerIdsText = "mcp_repo";

  const hints = buildBindingPolicyHints(d);
  const text = hints.map((hint) => hint.message).join("\n");

  assert.equal(hints.some((hint) => hint.tone === "info"), true);
  assert.doesNotMatch(text, /cannot enforce AgentProfile MCP bindings/);
  assert.match(text, /Codex MCP binding/);
  assert.match(text, /stdio\/no-secret/);
});

test("buildBindingPolicyHints warns when Codex profile has tool policy", () => {
  const d = emptyDraft();
  d.name = "Codex Tool Policy";
  d.provider = "codex";
  d.toolAllowlistText = "Read";
  d.toolDenylistText = "Bash";

  const hints = buildBindingPolicyHints(d);
  const text = hints.map((hint) => hint.message).join("\n");

  assert.equal(hints.some((hint) => hint.tone === "warning"), true);
  assert.match(text, /Codex provider cannot enforce AgentProfile tool policy/);
  assert.match(text, /profile boundary/);
});

test("buildBindingPolicyHints warns when auto provider may resolve to Codex with unsupported tool policy", () => {
  const d = emptyDraft();
  d.name = "Auto Boundaries";
  d.provider = "auto";
  d.mcpServerIdsText = "mcp_repo";
  d.toolDenylistText = "Bash";

  const hints = buildBindingPolicyHints(d);
  const text = hints.map((hint) => hint.message).join("\n");

  assert.match(text, /provider=auto/);
  assert.match(text, /Codex/);
  assert.match(text, /tool policy/);
  assert.match(text, /Codex MCP binding/);
});

test("buildBindingPolicyHints surfaces broad skill scope when allowedSkillIds is empty", () => {
  const d = emptyDraft();
  d.name = "Skill Source Only";
  d.skillSourceIdsText = "ss_project";

  const hints = buildBindingPolicyHints(d);

  assert.match(
    hints.map((hint) => hint.message).join("\n"),
    /전체 enabled Skill 후보/,
  );
});

test("buildBindingPolicyHints explains tool deny priority and event boundary", () => {
  const d = emptyDraft();
  d.name = "Tool Policy";
  d.toolAllowlistText = "mcp__repo__*";
  d.toolDenylistText = "mcp__repo__delete_*";

  const hints = buildBindingPolicyHints(d);
  const text = hints.map((hint) => hint.message).join("\n");

  assert.match(text, /deny pattern이 allow pattern보다 우선/);
  assert.match(text, /provider tool-call event/);
});
