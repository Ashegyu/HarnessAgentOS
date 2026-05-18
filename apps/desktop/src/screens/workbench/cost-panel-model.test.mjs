import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetProgressPercent,
  budgetProgressTone,
  hasCostData,
  visibleBudgetProgress,
} from "./cost-panel-model.ts";

const baseSummary = {
  taskRunId: "tsk_cost",
  totalCostUsd: 0,
  totalLatencyMs: 0,
  invocationCount: 0,
  perModel: [],
  invocations: [],
};

test("visibleBudgetProgress hides budget bars when no budget is configured", () => {
  assert.deepEqual(visibleBudgetProgress(baseSummary), []);
  assert.equal(hasCostData(baseSummary), false);
});

test("budgetProgressTone marks over-limit usage as failed", () => {
  const progress = {
    scope: "per_task_run",
    label: "TaskRun",
    usedUsd: 1.25,
    limitUsd: 1,
    ratio: 1.25,
    exceeded: true,
  };

  assert.equal(budgetProgressTone(progress), "failed");
  assert.equal(budgetProgressPercent(progress), 100);
});

test("budgetProgressTone warns near limit and passes below threshold", () => {
  assert.equal(
    budgetProgressTone({
      scope: "per_day",
      label: "Today",
      usedUsd: 0.85,
      limitUsd: 1,
      ratio: 0.85,
      exceeded: false,
    }),
    "warning",
  );
  assert.equal(
    budgetProgressTone({
      scope: "per_invocation",
      label: "Per invocation",
      usedUsd: 0.1,
      limitUsd: 1,
      ratio: 0.1,
      exceeded: false,
    }),
    "passed",
  );
});
