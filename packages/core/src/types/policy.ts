import type { ApprovalActionType } from "./approval.ts";

export type PolicyDecision = "allowed" | "confirm" | "blocked";

export type PolicyOperation =
  | { kind: "approval_action"; actionType: ApprovalActionType }
  | { kind: "read_operation"; name: "read" | "list" | "inspect" }
  | { kind: "path_violation"; name: "target_outside_workspace" | "path_traversal" }
  | { kind: "remote_side_effect"; name: "git_push" | "remote_agent_write" };

export interface PolicyEvaluation {
  operation: PolicyOperation;
  decision: PolicyDecision;
  riskLevel: "low" | "medium" | "high" | "blocked";
  allowAutoApprove: boolean;
  reason: string;
}

export interface PolicyRule {
  id: string;
  subjectType: "agent_profile" | "skill" | "runner" | "remote_agent";
  subjectId: string;
  operation: PolicyOperation;
  decision: PolicyDecision;
  reason: string;
  scope: "global" | "project" | "thread";
}
