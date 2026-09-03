import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ROLE_MODEL_DEFAULTS,
  CODEX_MODELS,
  WORKER_ROLES,
} from "@harness/core";

test("AGENT_ROLE_MODEL_DEFAULTS covers every worker role with a supported Codex model", () => {
  assert.deepEqual(AGENT_ROLE_MODEL_DEFAULTS, {
    planner: { model: "gpt-5.6-sol", reasoningEffort: "high" },
    coder: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    reviewer: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    tester: { model: "gpt-5.6-terra", reasoningEffort: "high" },
    orchestrator: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    "security-reviewer": { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    "build-error-resolver": {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
    "refactor-cleaner": { model: "gpt-5.6-terra", reasoningEffort: "high" },
    "performance-reviewer": {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
    documenter: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
  });

  assert.deepEqual(Object.keys(AGENT_ROLE_MODEL_DEFAULTS), [...WORKER_ROLES]);
  assert.deepEqual(
    [...new Set(Object.values(AGENT_ROLE_MODEL_DEFAULTS).map(({ model }) => model))].sort(),
    [...CODEX_MODELS].sort(),
    "the role allocation must intentionally use every supported Codex model tier",
  );
});
