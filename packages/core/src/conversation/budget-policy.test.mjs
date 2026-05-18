import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBudget } from "./budget-policy.ts";

const approval = (costEstimateUsd) => ({
  actionType: "model_use",
  policyEvaluation:
    costEstimateUsd === undefined
      ? undefined
      : {
          operation: { kind: "approval_action", actionType: "model_use" },
          decision: "confirm",
          riskLevel: "medium",
          allowAutoApprove: true,
          reason: "model selection",
          costEstimateUsd,
        },
});

const profile = (budget) => ({
  permissions: {
    autoApproveActions: ["model_use"],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
    budget,
  },
});

test("evaluateBudget allows when no profile budget is configured", () => {
  const decision = evaluateBudget({
    approval: approval(0.75),
    profile: profile(undefined),
    accumulatedTaskRunCostUsd: 0,
    accumulatedDailyCostUsd: 0,
  });
  assert.equal(decision.kind, "allow");
});

test("evaluateBudget allows approvals without a cost estimate", () => {
  const decision = evaluateBudget({
    approval: approval(undefined),
    profile: profile({ perInvocationUsd: 0.01 }),
    accumulatedTaskRunCostUsd: 0,
    accumulatedDailyCostUsd: 0,
  });
  assert.equal(decision.kind, "allow");
});

test("evaluateBudget blocks a single invocation above perInvocationUsd", () => {
  const decision = evaluateBudget({
    approval: approval(0.12),
    profile: profile({ perInvocationUsd: 0.1 }),
    accumulatedTaskRunCostUsd: 0,
    accumulatedDailyCostUsd: 0,
  });
  assert.equal(decision.kind, "blocked");
  assert.equal(decision.scope, "per_invocation");
  assert.match(decision.reason, /budget 차단/);
  assert.match(decision.reason, /\$0\.12/);
  assert.match(decision.reason, /\$0\.10/);
});

test("evaluateBudget blocks when TaskRun accumulated cost would exceed the limit", () => {
  const decision = evaluateBudget({
    approval: approval(0.06),
    profile: profile({ perTaskRunUsd: 0.1 }),
    accumulatedTaskRunCostUsd: 0.05,
    accumulatedDailyCostUsd: 0,
  });
  assert.equal(decision.kind, "blocked");
  assert.equal(decision.scope, "per_task_run");
  assert.equal(decision.accumulatedCostUsd, 0.05);
});

test("evaluateBudget blocks when daily accumulated cost would exceed the limit", () => {
  const decision = evaluateBudget({
    approval: approval(0.25),
    profile: profile({ perDayUsd: 1 }),
    accumulatedTaskRunCostUsd: 0,
    accumulatedDailyCostUsd: 0.9,
  });
  assert.equal(decision.kind, "blocked");
  assert.equal(decision.scope, "per_day");
});

test("evaluateBudget allows when projected totals equal configured limits", () => {
  const decision = evaluateBudget({
    approval: approval(0.05),
    profile: profile({
      perInvocationUsd: 0.05,
      perTaskRunUsd: 0.1,
      perDayUsd: 1,
    }),
    accumulatedTaskRunCostUsd: 0.05,
    accumulatedDailyCostUsd: 0.95,
  });
  assert.equal(decision.kind, "allow");
});
