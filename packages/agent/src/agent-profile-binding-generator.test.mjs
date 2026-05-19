import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMcpServerBindingProposal,
  applySkillSourceBindingProposal,
  buildMcpServerBindingProposal,
  buildSkillSourceBindingProposal,
} from "./agent-profile-binding-generator.ts";

const profile = (overrides = {}) => ({
  id: "ap_reviewer",
  name: "Reviewer",
  description: "",
  category: "review",
  tags: ["review"],
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
    allowedSkillIds: ["review-skill"],
    toolAllowlist: ["mcp__repo__*"],
    toolDenylist: ["mcp__repo__delete_*"],
  },
  mcpServerIds: ["mcp_existing"],
  skillSourceIds: ["ss_project"],
  isDefault: false,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  ...overrides,
});

const server = (overrides = {}) => ({
  id: "mcp_repo",
  name: "Repo MCP",
  description: "",
  transport: "stdio",
  command: "node",
  args: ["server.mjs"],
  env: {},
  envSecretRefs: {},
  scope: "per-agent",
  enabled: true,
  lastHealth: {
    okAt: "2026-05-12T00:00:00.000Z",
    checkedAt: "2026-05-12T00:00:00.000Z",
  },
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  ...overrides,
});

const source = (overrides = {}) => ({
  id: "ss_generated",
  name: "Generated Skills",
  origin: "custom",
  rootDir: "/tmp/skills",
  trusted: true,
  enabled: true,
  registeredInPathPolicy: true,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  ...overrides,
});

test("buildMcpServerBindingProposal adds a per-agent server without duplicating existing ids", () => {
  const result = buildMcpServerBindingProposal({
    profile: profile(),
    server: server(),
  });

  assert.deepEqual(result.proposal.addMcpServerIds, ["mcp_repo"]);
  assert.deepEqual(result.preview.before.mcpServerIds, ["mcp_existing"]);
  assert.deepEqual(result.preview.after.mcpServerIds, [
    "mcp_existing",
    "mcp_repo",
  ]);
  assert.equal(result.preview.alreadySatisfied, false);
  assert.equal(result.proposal.risk, "low");
  assert.deepEqual(result.proposal.addSkillSourceIds, []);
  assert.deepEqual(result.proposal.allowSkillIds, []);
  assert.deepEqual(result.proposal.addToolAllowPatterns, []);
  assert.deepEqual(result.proposal.addToolDenyPatterns, []);
});

test("buildMcpServerBindingProposal reports an already-bound per-agent server as a no-op", () => {
  const result = buildMcpServerBindingProposal({
    profile: profile({ mcpServerIds: ["mcp_existing", "mcp_repo"] }),
    server: server(),
  });

  assert.deepEqual(result.proposal.addMcpServerIds, []);
  assert.deepEqual(result.preview.after.mcpServerIds, [
    "mcp_existing",
    "mcp_repo",
  ]);
  assert.equal(result.preview.alreadySatisfied, true);
  assert.match(result.preview.warnings.join("\n"), /already includes/);
});

test("buildMcpServerBindingProposal does not bind global servers to a profile", () => {
  const result = buildMcpServerBindingProposal({
    profile: profile(),
    server: server({ scope: "global" }),
  });

  assert.deepEqual(result.proposal.addMcpServerIds, []);
  assert.deepEqual(result.preview.after.mcpServerIds, ["mcp_existing"]);
  assert.equal(result.preview.alreadySatisfied, true);
  assert.match(result.preview.warnings.join("\n"), /global MCP server/);
});

test("buildMcpServerBindingProposal warns when Codex binding uses limited verified delivery", () => {
  const result = buildMcpServerBindingProposal({
    profile: profile({ provider: "codex" }),
    server: server({ enabled: false, lastHealth: undefined }),
  });

  const warnings = result.preview.warnings.join("\n");
  assert.match(warnings, /Codex per-run MCP delivery uses verified/);
  assert.match(warnings, /disabled/);
  assert.match(warnings, /health check has not succeeded/);
  assert.equal(result.proposal.risk, "medium");
});

test("applyMcpServerBindingProposal applies only the proposed mcpServerIds", () => {
  const original = profile();
  const result = buildMcpServerBindingProposal({
    profile: original,
    server: server(),
  });

  const updated = applyMcpServerBindingProposal(original, result);

  assert.deepEqual(updated.mcpServerIds, ["mcp_existing", "mcp_repo"]);
  assert.deepEqual(updated.skillSourceIds, original.skillSourceIds);
  assert.deepEqual(
    updated.permissions.allowedSkillIds,
    original.permissions.allowedSkillIds,
  );
  assert.deepEqual(
    updated.permissions.toolDenylist,
    original.permissions.toolDenylist,
  );
  assert.deepEqual(original.mcpServerIds, ["mcp_existing"]);
});

test("applyMcpServerBindingProposal rejects mismatched profiles", () => {
  const result = buildMcpServerBindingProposal({
    profile: profile({ id: "ap_a" }),
    server: server(),
  });

  assert.throws(
    () => applyMcpServerBindingProposal(profile({ id: "ap_b" }), result),
    /does not target AgentProfile/,
  );
});

test("buildSkillSourceBindingProposal adds source and explicit allowed skill ids", () => {
  const result = buildSkillSourceBindingProposal({
    profile: profile(),
    source: source(),
    capabilityIds: ["review-helper", "review-helper", "repair-helper"],
  });

  assert.deepEqual(result.proposal.addSkillSourceIds, ["ss_generated"]);
  assert.deepEqual(result.proposal.allowSkillIds, [
    "review-helper",
    "repair-helper",
  ]);
  assert.deepEqual(result.preview.after.skillSourceIds, [
    "ss_project",
    "ss_generated",
  ]);
  assert.deepEqual(result.preview.after.allowedSkillIds, [
    "review-skill",
    "review-helper",
    "repair-helper",
  ]);
  assert.equal(result.preview.alreadySatisfied, false);
});

test("buildSkillSourceBindingProposal does not narrow all-skills profiles", () => {
  const result = buildSkillSourceBindingProposal({
    profile: profile({
      permissions: {
        ...profile().permissions,
        allowedSkillIds: [],
      },
    }),
    source: source(),
    capabilityIds: ["review-helper"],
  });

  assert.deepEqual(result.proposal.allowSkillIds, []);
  assert.deepEqual(result.preview.after.allowedSkillIds, []);
  assert.match(result.preview.warnings.join("\n"), /already allows all/);
});

test("applySkillSourceBindingProposal updates only skill source and allowed skill ids", () => {
  const original = profile();
  const result = buildSkillSourceBindingProposal({
    profile: original,
    source: source(),
    capabilityIds: ["review-helper"],
  });

  const updated = applySkillSourceBindingProposal(original, result);

  assert.deepEqual(updated.skillSourceIds, ["ss_project", "ss_generated"]);
  assert.deepEqual(updated.permissions.allowedSkillIds, [
    "review-skill",
    "review-helper",
  ]);
  assert.deepEqual(updated.mcpServerIds, original.mcpServerIds);
  assert.deepEqual(updated.permissions.toolAllowlist, original.permissions.toolAllowlist);
  assert.deepEqual(original.skillSourceIds, ["ss_project"]);
});
