import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  budgetProgressPercent,
  budgetProgressTone,
  hasCostData,
  visibleBudgetProgress,
} from "./cost-panel-model.ts";

globalThis.React = React;
const { CostSummaryView } = await import("./CostPanel.tsx");

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

test("CostSummaryView renders unknown provider cost instead of a zero-dollar estimate", () => {
  const html = renderToStaticMarkup(
    React.createElement(CostSummaryView, {
      summary: {
        taskRunId: "tsk_unknown_cost",
        totalCostUsd: 0,
        totalLatencyMs: 1200,
        invocationCount: 1,
        knownCostInvocationCount: 0,
        unknownCostInvocationCount: 1,
        perModel: [
          {
            model: "gpt-unknown-price",
            cost: 0,
            latencyMs: 1200,
            count: 1,
            knownCostInvocationCount: 0,
            unknownCostInvocationCount: 1,
          },
        ],
        invocations: [
          {
            id: "ainv_unknown",
            model: "gpt-unknown-price",
            cost: 0,
            costKnown: false,
            latencyMs: 1200,
            createdAt: "2026-05-18T00:00:00.000Z",
            success: true,
          },
        ],
      },
    }),
  );

  assert.match(html, /Unknown/);
  assert.match(html, /1 call has unknown USD cost/);
  assert.doesNotMatch(html, /<dd>\$0\.00<\/dd>/);
});
