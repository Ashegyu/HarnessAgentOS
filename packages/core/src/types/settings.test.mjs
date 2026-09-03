import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HARNESS_SETTINGS,
} from "./settings.ts";
import {
  AGENT_REASONING_EFFORTS,
  CODEX_MODELS,
  DEFAULT_AGENT_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
} from "./codex-models.ts";

test("Codex model and reasoning catalogs expose only supported choices", () => {
  assert.deepEqual([...CODEX_MODELS], [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  assert.deepEqual([...AGENT_REASONING_EFFORTS], [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(DEFAULT_AGENT_REASONING_EFFORT, "medium");
});

test("DEFAULT_HARNESS_SETTINGS has expected agent defaults", () => {
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.provider, "codex");
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.model, DEFAULT_CODEX_MODEL);
  assert.equal(
    DEFAULT_HARNESS_SETTINGS.agent.reasoningEffort,
    DEFAULT_AGENT_REASONING_EFFORT,
  );
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.timeoutMs, 60 * 60_000);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.stallTimeoutMs, 10 * 60_000);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.contextDepth, 5);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.codexWorkspaceWrite, false);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.codexAutoReview, false);
});

test("DEFAULT_HARNESS_SETTINGS is frozen (immutable)", () => {
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS.agent));
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS.orchestration));
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS.approval));
});

test("DEFAULT_HARNESS_SETTINGS has expected orchestration defaults", () => {
  assert.equal(DEFAULT_HARNESS_SETTINGS.orchestration.enabled, false);
});

test("DEFAULT_HARNESS_SETTINGS leaves activeAgentProfileId undefined", () => {
  // No profile is "active" by default — the resolver falls back to
  // the row marked isDefault, or the legacy agent settings when no
  // AgentProfile rows exist yet.
  assert.equal(DEFAULT_HARNESS_SETTINGS.activeAgentProfileId, undefined);
});

test("DEFAULT_HARNESS_SETTINGS enables narrow worker file auto-run by default", () => {
  assert.equal(DEFAULT_HARNESS_SETTINGS.approval.autoApprove, false);
  assert.equal(
    DEFAULT_HARNESS_SETTINGS.approval.autoExecuteWorkerFileActions,
    true,
  );
  assert.equal(
    DEFAULT_HARNESS_SETTINGS.approval.workerFileAutoExecutionConfigured,
    false,
  );
});
