import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRisk,
  requiresApproval,
  toProposedAction,
} from "./approval-policy.ts";

test("file_write and shell are medium risk", () => {
  assert.equal(classifyRisk("file_write"), "medium");
  assert.equal(classifyRisk("shell"), "medium");
  assert.equal(classifyRisk("model_use"), "medium");
});

test("dependency_install/network/git_commit/skill_script/orchestration_plan are high", () => {
  for (const a of [
    "dependency_install",
    "network",
    "git_commit",
    "skill_script",
    "orchestration_plan",
  ]) {
    assert.equal(classifyRisk(a), "high");
  }
});

test("all listed action types require approval in Phase 2", () => {
  for (const a of [
    "capability_use",
    "model_use",
    "file_write",
    "shell",
    "dependency_install",
    "git_commit",
    "network",
    "skill_script",
    "orchestration_plan",
  ]) {
    assert.equal(requiresApproval(a), true);
  }
});

test("toProposedAction emits requiresApproval=true and sets risk", () => {
  const a = toProposedAction("file_write", "edit foo.ts");
  assert.equal(a.requiresApproval, true);
  assert.equal(a.riskLevel, "medium");
  assert.equal(a.summary, "edit foo.ts");
});
