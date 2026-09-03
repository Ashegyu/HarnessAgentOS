import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_ROLE_MODEL_DEFAULTS, DEFAULT_CODEX_MODEL } from "@harness/core";
import { workerProfileToAgentProfileInput } from "./profile-migrator.ts";

const legacyAgent = {
  provider: "claude",
  model: "claude-sonnet-4",
  timeoutMs: 600_000,
  stallTimeoutMs: 90_000,
  contextDepth: 7,
};

test("workerProfileToAgentProfileInput fills tuning from legacy agent settings", () => {
  const wp = {
    id: "wp_1",
    name: "Coder Claude",
    provider: "claude",
    model: "claude-sonnet-4",
    role: "coder",
  };
  const ap = workerProfileToAgentProfileInput(wp, legacyAgent, { isDefault: true });
  assert.equal(ap.name, "Coder Claude");
  assert.equal(ap.provider, "codex");
  assert.equal(ap.role, "coder");
  assert.equal(ap.category, "legacy");
  assert.deepEqual(ap.tags, ["legacy-worker", "coder"]);
  assert.equal(ap.tuning.model, AGENT_ROLE_MODEL_DEFAULTS.coder.model);
  assert.equal(
    ap.tuning.reasoningEffort,
    AGENT_ROLE_MODEL_DEFAULTS.coder.reasoningEffort,
  );
  assert.equal(ap.tuning.timeoutMs, 600_000);
  assert.equal(ap.tuning.stallTimeoutMs, 90_000);
  assert.equal(ap.tuning.contextDepth, 7);
  assert.equal(ap.tuning.systemPromptPrefix, "");
  assert.equal(ap.tuning.systemPromptSuffix, "");
  assert.equal(ap.persona, "");
  assert.equal(ap.isDefault, true);
  assert.deepEqual(ap.mcpServerIds, []);
  assert.deepEqual(ap.skillSourceIds, []);
  assert.deepEqual(ap.permissions.autoApproveActions, []);
  assert.equal(ap.cli.cliPathOverride, "");
});

test("workerProfileToAgentProfileInput defaults isDefault=false", () => {
  const wp = { id: "wp_1", name: "X", provider: "auto", model: "", role: "coder" };
  const ap = workerProfileToAgentProfileInput(wp, legacyAgent);
  assert.equal(ap.isDefault, false);
  assert.equal(ap.provider, "codex");
  assert.equal(ap.tuning.model, AGENT_ROLE_MODEL_DEFAULTS.coder.model);
});

test("workerProfileToAgentProfileInput applies the role allocation over a legacy model", () => {
  const wp = {
    id: "wp_1",
    name: "Reviewer",
    provider: "codex",
    model: "gpt-5.6-luna",
    role: "reviewer",
  };
  const ap = workerProfileToAgentProfileInput(wp, legacyAgent);
  assert.equal(ap.tuning.model, "gpt-5.6-terra");
  assert.equal(ap.provider, "codex");
});
