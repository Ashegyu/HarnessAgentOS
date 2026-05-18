import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  budgetUsageTone,
  dailyBudgetPercent,
  isBudgetUsageEmpty,
  maxDailyProfileCost,
} from "./budget-overview-model.ts";

globalThis.React = React;
const { BudgetOverviewContent } = await import("./BudgetOverviewTab.tsx");

const emptySummary = {
  sinceIso: "2026-05-12T00:00:00.000Z",
  untilIso: "2026-05-18T23:59:59.999Z",
  todayIso: "2026-05-18",
  days: 7,
  todayCostUsd: 0,
  windowCostUsd: 0,
  averageDailyCostUsd: 0,
  profiles: [],
  topModels: [],
};

test("BudgetOverviewContent renders an empty data placeholder", () => {
  const html = renderToStaticMarkup(
    React.createElement(BudgetOverviewContent, { summary: emptySummary }),
  );

  assert.match(html, /표시할 budget 사용량이 없습니다/);
  assert.equal(isBudgetUsageEmpty(emptySummary), true);
});

test("budget overview helpers classify daily budget usage", () => {
  const profile = {
    profileId: "ap_coder",
    profileName: "Coder",
    model: "gpt-5.5",
    budget: { perDayUsd: 1 },
    todayCostUsd: 0.85,
    windowCostUsd: 1.2,
    averageDailyCostUsd: 0.6,
    dailyBudgetRatio: 0.85,
    daily: [
      { dateIso: "2026-05-17", totalCostUsd: 0.35, count: 1 },
      { dateIso: "2026-05-18", totalCostUsd: 0.85, count: 2 },
    ],
  };

  assert.equal(budgetUsageTone(profile), "warning");
  assert.equal(dailyBudgetPercent(profile), 85);
  assert.equal(maxDailyProfileCost({ ...emptySummary, profiles: [profile] }), 0.85);
});
