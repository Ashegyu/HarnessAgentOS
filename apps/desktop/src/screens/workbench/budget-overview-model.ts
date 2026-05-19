import type {
  BudgetUsageProfileSummary,
  BudgetUsageSummary,
} from "@harness/core";

export type BudgetUsageTone = "passed" | "warning" | "failed" | "neutral";

export const isBudgetUsageEmpty = (summary: BudgetUsageSummary): boolean =>
  summary.profiles.length === 0 &&
  summary.topModels.length === 0 &&
  summary.windowCostUsd === 0 &&
  unknownBudgetUsageCount(summary) === 0;

export const unknownBudgetUsageCount = (
  summary: BudgetUsageSummary,
): number =>
  summary.unknownCostInvocationCount ??
  summary.profiles.reduce(
    (sum, profile) => sum + (profile.unknownCostInvocationCount ?? 0),
    0,
  );

export const budgetUsageTone = (
  profile: BudgetUsageProfileSummary,
): BudgetUsageTone => {
  if (profile.dailyBudgetRatio === undefined) return "neutral";
  if (profile.dailyBudgetRatio > 1) return "failed";
  return profile.dailyBudgetRatio >= 0.8 ? "warning" : "passed";
};

export const maxDailyProfileCost = (summary: BudgetUsageSummary): number =>
  Math.max(
    0,
    ...summary.profiles.flatMap((profile) =>
      profile.daily.map((point) => point.totalCostUsd),
    ),
  );

export const dailyBudgetPercent = (
  profile: BudgetUsageProfileSummary,
): number =>
  profile.dailyBudgetRatio === undefined
    ? 0
    : Math.max(0, Math.min(100, profile.dailyBudgetRatio * 100));
