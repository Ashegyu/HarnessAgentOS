import type { ApprovalActionType } from "../types";
import type { ProposedAction } from "./types";

/**
 * Phase 2 approval policy. Per
 * docs/architecture/security-and-approval-architecture.md, every
 * side-effecting action requires explicit user approval before
 * execution. Phase 2 only records the requirement; Phase 3 enforces
 * during runner execution.
 */

const ACTIONS_REQUIRING_APPROVAL: ReadonlySet<ApprovalActionType> = new Set([
  "file_write",
  "shell",
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
  "orchestration_plan",
]);

const HIGH_RISK_ACTIONS: ReadonlySet<ApprovalActionType> = new Set([
  "dependency_install",
  "network",
  "git_commit",
  "skill_script",
  "orchestration_plan",
]);

export const requiresApproval = (action: ApprovalActionType): boolean =>
  ACTIONS_REQUIRING_APPROVAL.has(action);

export const classifyRisk = (
  action: ApprovalActionType,
): "low" | "medium" | "high" => {
  if (HIGH_RISK_ACTIONS.has(action)) return "high";
  if (action === "shell" || action === "file_write") return "medium";
  return "low";
};

export const toProposedAction = (
  type: ApprovalActionType,
  summary: string,
): ProposedAction => ({
  type,
  summary,
  riskLevel: classifyRisk(type),
  requiresApproval: true,
});
