import type {
  TaskRunCostBudgetProgress,
  TaskRunCostSummary,
} from "@harness/core";

export type BudgetProgressTone = "passed" | "warning" | "failed";

export const visibleBudgetProgress = (
  summary: TaskRunCostSummary,
): TaskRunCostBudgetProgress[] => summary.budget?.progress ?? [];

export const budgetProgressTone = (
  progress: TaskRunCostBudgetProgress,
): BudgetProgressTone => {
  if (progress.exceeded) return "failed";
  return progress.ratio >= 0.8 ? "warning" : "passed";
};

export const budgetProgressPercent = (
  progress: TaskRunCostBudgetProgress,
): number => Math.max(0, Math.min(100, progress.ratio * 100));

export const hasCostData = (summary: TaskRunCostSummary): boolean =>
  summary.invocationCount > 0 || summary.totalCostUsd > 0 || summary.totalLatencyMs > 0;
