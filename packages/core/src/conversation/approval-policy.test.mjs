import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRisk,
  evaluateApprovalActionPolicy,
  evaluatePolicyOperation,
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

test("evaluateApprovalActionPolicy confirms approval actions and gates high risk auto approval", () => {
  const fileWrite = evaluateApprovalActionPolicy("file_write");
  assert.deepEqual(fileWrite.operation, {
    kind: "approval_action",
    actionType: "file_write",
  });
  assert.equal(fileWrite.decision, "confirm");
  assert.equal(fileWrite.riskLevel, "medium");
  assert.equal(fileWrite.allowAutoApprove, true);

  const dependencyInstall = evaluateApprovalActionPolicy("dependency_install");
  assert.equal(dependencyInstall.decision, "confirm");
  assert.equal(dependencyInstall.riskLevel, "high");
  assert.equal(dependencyInstall.allowAutoApprove, false);
});

test("evaluatePolicyOperation blocks path and remote side effects", () => {
  const pathViolation = evaluatePolicyOperation({
    kind: "path_violation",
    name: "path_traversal",
  });
  assert.equal(pathViolation.decision, "blocked");
  assert.equal(pathViolation.riskLevel, "blocked");
  assert.equal(pathViolation.allowAutoApprove, false);

  const read = evaluatePolicyOperation({
    kind: "read_operation",
    name: "inspect",
  });
  assert.equal(read.decision, "allowed");
  assert.equal(read.allowAutoApprove, true);
});
