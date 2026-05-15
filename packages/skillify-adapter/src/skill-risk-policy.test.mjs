import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySkillRisk,
  isScriptExecutionAllowed,
} from "./skill-risk-policy.ts";

test("classifySkillRisk floors untrusted skills at medium", () => {
  assert.equal(
    classifySkillRisk({
      declared: "low",
      allowedActions: [],
      trusted: false,
    }),
    "medium",
  );
});

test("classifySkillRisk considers required approvals as action risk", () => {
  assert.equal(
    classifySkillRisk({
      declared: "low",
      allowedActions: [],
      requiredApprovals: ["network"],
      trusted: true,
    }),
    "high",
  );
});

test("classifySkillRisk keeps file_write at medium", () => {
  assert.equal(
    classifySkillRisk({
      declared: "low",
      allowedActions: ["file_write"],
      trusted: true,
    }),
    "medium",
  );
});

test("isScriptExecutionAllowed refuses untrusted skills", () => {
  assert.equal(
    isScriptExecutionAllowed({ trusted: false, riskLevel: "low" }),
    false,
  );
  assert.equal(
    isScriptExecutionAllowed({ trusted: true, riskLevel: "high" }),
    true,
  );
});
