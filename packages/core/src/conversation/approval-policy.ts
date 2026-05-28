import type {
  ApprovalActionType,
  PolicyEvaluation,
  PolicyOperation,
} from "../types/index.ts";
import type { ProposedAction } from "./types.ts";

/**
 * Phase 2 approval policy. Per
 * docs/architecture/security-and-approval-architecture.md, every
 * side-effecting action requires explicit user approval before
 * execution. Phase 2 only records the requirement; Phase 3 enforces
 * during runner execution.
 */

const ACTIONS_REQUIRING_APPROVAL: ReadonlySet<ApprovalActionType> = new Set([
  "capability_use",
  "model_use",
  "file_patch",
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

const MANUAL_ONLY_ACTIONS: ReadonlySet<ApprovalActionType> = new Set([
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
  if (
    action === "shell" ||
    action === "file_patch" ||
    action === "file_write" ||
    action === "model_use"
  )
    return "medium";
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

export const evaluateApprovalActionPolicy = (
  actionType: ApprovalActionType,
): PolicyEvaluation => ({
  operation: { kind: "approval_action", actionType },
  decision: "confirm",
  riskLevel: classifyRisk(actionType),
  allowAutoApprove: !MANUAL_ONLY_ACTIONS.has(actionType),
  reason: approvalActionReason(actionType),
});

export const evaluatePolicyOperation = (
  operation: PolicyOperation,
): PolicyEvaluation => {
  switch (operation.kind) {
    case "approval_action":
      return evaluateApprovalActionPolicy(operation.actionType);
    case "read_operation":
      return {
        operation,
        decision: "allowed",
        riskLevel: "low",
        allowAutoApprove: true,
        reason: "Read-only operation; no side effect is performed.",
      };
    case "path_violation":
      return {
        operation,
        decision: "blocked",
        riskLevel: "blocked",
        allowAutoApprove: false,
        reason: "Path escapes the allowed workspace boundary.",
      };
    case "remote_side_effect":
      return {
        operation,
        decision: "blocked",
        riskLevel: "blocked",
        allowAutoApprove: false,
        reason: "Remote side effects are blocked by default.",
      };
  }
};

export class PolicyService {
  evaluate(operation: PolicyOperation): PolicyEvaluation {
    return evaluatePolicyOperation(operation);
  }
}

const approvalActionReason = (actionType: ApprovalActionType): string => {
  switch (actionType) {
    case "capability_use":
      return "Capability use can influence prompt context and must be confirmed.";
    case "model_use":
      return "Model selection can affect cost and quality and must be confirmed.";
    case "file_patch":
      return "File patches modify the workspace and must be confirmed.";
    case "file_write":
      return "File writes modify the workspace and must be confirmed.";
    case "shell":
      return "Shell commands run with local permissions and must be confirmed.";
    case "dependency_install":
      return "Dependency installation has supply-chain risk and requires manual confirmation.";
    case "network":
      return "Network operations can transmit data externally and require manual confirmation.";
    case "git_commit":
      return "Git commits change repository history and require manual confirmation.";
    case "skill_script":
      return "Skill scripts can run local code and require manual confirmation.";
    case "orchestration_plan":
      return "Orchestration starts a worker chain and requires manual confirmation.";
  }
};
