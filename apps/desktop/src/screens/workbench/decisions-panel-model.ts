import type { Approval, AutoApproveStep } from "@harness/core";
import { AUTO_APPROVE_STEP_LABELS } from "./ApprovalDecisionTrace";

export interface DecisionTimelineRow {
  approvalId: string;
  actionType: Approval["actionType"];
  actionSummary: string;
  approved: boolean;
  decidedAtStep: AutoApproveStep;
  decidedAtLabel: string;
  reason: string;
  timeIso?: string;
}

export const buildDecisionTimelineRows = (
  approvals: readonly Approval[],
): DecisionTimelineRow[] =>
  approvals
    .filter((approval) => approval.autoApproveDecision)
    .map((approval) => {
      const decision = approval.autoApproveDecision!;
      return {
        approvalId: approval.id,
        actionType: approval.actionType,
        actionSummary: approval.actionSummary,
        approved: decision.approved,
        decidedAtStep: decision.decidedAt,
        decidedAtLabel: AUTO_APPROVE_STEP_LABELS[decision.decidedAt],
        reason: decision.reason,
        ...(approval.decidedAt ? { timeIso: approval.decidedAt } : {}),
      };
    })
    .sort(compareDecisionRows);

export const filterDecisionRows = (
  rows: readonly DecisionTimelineRow[],
  selectedSteps: ReadonlySet<AutoApproveStep>,
): DecisionTimelineRow[] => {
  if (selectedSteps.size === 0) return [];
  return rows.filter((row) => selectedSteps.has(row.decidedAtStep));
};

const compareDecisionRows = (
  left: DecisionTimelineRow,
  right: DecisionTimelineRow,
): number => {
  const leftTime = left.timeIso ?? "";
  const rightTime = right.timeIso ?? "";
  return (
    leftTime.localeCompare(rightTime) ||
    left.approvalId.localeCompare(right.approvalId)
  );
};
