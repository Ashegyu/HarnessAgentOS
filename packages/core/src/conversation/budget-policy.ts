import type { AgentPermissions } from "../types/agent-profile.ts";
import type { Approval } from "../types/approval.ts";
import type { PolicyBudgetDecision } from "../types/policy.ts";

export interface BudgetPolicyProfile {
  permissions: Pick<AgentPermissions, "budget">;
}

export interface EvaluateBudgetInput {
  approval: Pick<Approval, "actionType" | "policyEvaluation">;
  profile: BudgetPolicyProfile | null;
  accumulatedTaskRunCostUsd?: number;
  accumulatedDailyCostUsd?: number;
}

export type BudgetDecision = PolicyBudgetDecision;

const ALLOW: BudgetDecision = Object.freeze({ kind: "allow" });

export const evaluateBudget = (
  input: EvaluateBudgetInput,
): BudgetDecision => {
  const budget = input.profile?.permissions.budget;
  if (!budget) return ALLOW;

  const costEstimateUsd = finiteNumber(
    input.approval.policyEvaluation?.costEstimateUsd,
  );
  if (costEstimateUsd === undefined) return ALLOW;

  const perInvocationUsd = finiteNumber(budget.perInvocationUsd);
  if (
    perInvocationUsd !== undefined &&
    exceeds(costEstimateUsd, perInvocationUsd)
  ) {
    return blocked({
      scope: "per_invocation",
      costEstimateUsd,
      accumulatedCostUsd: 0,
      projectedCostUsd: costEstimateUsd,
      limitUsd: perInvocationUsd,
    });
  }

  const perTaskRunUsd = finiteNumber(budget.perTaskRunUsd);
  if (perTaskRunUsd !== undefined) {
    const accumulated = nonNegative(input.accumulatedTaskRunCostUsd);
    const projected = accumulated + costEstimateUsd;
    if (exceeds(projected, perTaskRunUsd)) {
      return blocked({
        scope: "per_task_run",
        costEstimateUsd,
        accumulatedCostUsd: accumulated,
        projectedCostUsd: projected,
        limitUsd: perTaskRunUsd,
      });
    }
  }

  const perDayUsd = finiteNumber(budget.perDayUsd);
  if (perDayUsd !== undefined) {
    const accumulated = nonNegative(input.accumulatedDailyCostUsd);
    const projected = accumulated + costEstimateUsd;
    if (exceeds(projected, perDayUsd)) {
      return blocked({
        scope: "per_day",
        costEstimateUsd,
        accumulatedCostUsd: accumulated,
        projectedCostUsd: projected,
        limitUsd: perDayUsd,
      });
    }
  }

  return ALLOW;
};

const blocked = (input: {
  scope: NonNullable<BudgetDecision["scope"]>;
  costEstimateUsd: number;
  accumulatedCostUsd: number;
  projectedCostUsd: number;
  limitUsd: number;
}): BudgetDecision => ({
  kind: "blocked",
  scope: input.scope,
  costEstimateUsd: input.costEstimateUsd,
  accumulatedCostUsd: input.accumulatedCostUsd,
  limitUsd: input.limitUsd,
  reason: formatReason(input),
});

const formatReason = (input: {
  scope: NonNullable<BudgetDecision["scope"]>;
  costEstimateUsd: number;
  projectedCostUsd: number;
  limitUsd: number;
}): string => {
  if (input.scope === "per_invocation") {
    return `budget 차단: 예상 비용 ${usd(input.costEstimateUsd)}, 한도 ${usd(input.limitUsd)}`;
  }
  const label =
    input.scope === "per_task_run" ? "TaskRun 누적 예상 비용" : "일일 누적 예상 비용";
  return `budget 차단: ${label} ${usd(input.projectedCostUsd)}, 한도 ${usd(input.limitUsd)}`;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const nonNegative = (value: unknown): number =>
  finiteNumber(value) ?? 0;

const exceeds = (projected: number, limit: number): boolean =>
  projected - limit > Number.EPSILON;

const usd = (value: number): string => `$${value.toFixed(2)}`;
