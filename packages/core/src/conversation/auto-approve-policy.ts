import type { AgentPermissions } from "../types/agent-profile.ts";
import type { Approval, AutoApproveDecision } from "../types/approval.ts";
import type { Checkpoint } from "../types/checkpoint.ts";
import { evaluateBudget } from "./budget-policy.ts";

/**
 * Stable surface for the renderer-side auto-approver. Only the fields the
 * policy looks at are required, so the caller can pass either a full
 * AgentProfile or a small stub.
 */
export interface AutoApproveActiveProfile {
  permissions: Pick<
    AgentPermissions,
    "autoApproveActions" | "blockedActions" | "budget"
  >;
}

export interface ShouldAutoApproveInput {
  approval: Pick<Approval, "actionType" | "policyEvaluation">;
  globalAutoApprove: boolean;
  activeProfile: AutoApproveActiveProfile | null;
  accumulatedTaskRunCostUsd?: number;
  accumulatedDailyCostUsd?: number;
  workerFileActionAutoApprove?: boolean;
  isWorkerFileAction?: boolean;
}

export const WORKER_ACTION_CHECKPOINT_SUMMARY_PREFIX =
  "worker action checkpoint";

export const workerActionCheckpointSummary = (actionCount: number): string =>
  `${WORKER_ACTION_CHECKPOINT_SUMMARY_PREFIX} (${actionCount} actions)`;

export const isWorkerFileActionApproval = (input: {
  approval: Pick<Approval, "actionType" | "checkpointId">;
  checkpoints: readonly Pick<Checkpoint, "id" | "summary">[];
}): boolean => {
  if (input.approval.actionType !== "file_write") return false;
  const checkpoint = input.checkpoints.find(
    (c) => c.id === input.approval.checkpointId,
  );
  return (
    checkpoint?.summary.startsWith(WORKER_ACTION_CHECKPOINT_SUMMARY_PREFIX) ??
    false
  );
};

/**
 * Decision rule — see docs/design/agent-detailed-settings.md §4.1 + §7:
 *
 *   1. If the active profile blocks the action type → false (block wins).
 *   2. If service-layer policy blocked the operation → false.
 *   3. If profile budget caps would be exceeded → false.
 *   4. If the active profile explicitly auto-approves the action → true.
 *   5. If service-layer policy disallows auto-approve → false.
 *   6. If narrow worker-file automation applies → true.
 *   7. Otherwise fall back to the global `approval.autoApprove` toggle.
 *
 * The block list takes priority over both per-profile auto-approve and
 * the global toggle so a "trust everything" boot can't bypass an
 * explicit per-profile prohibition (e.g. for a production agent that
 * must never auto-execute `git_commit`).
 */
const decision = (
  approved: boolean,
  decidedAt: AutoApproveDecision["decidedAt"],
  reason: string,
): AutoApproveDecision => ({ approved, decidedAt, reason });

export const shouldAutoApprove = (
  input: ShouldAutoApproveInput,
): AutoApproveDecision => {
  const { approval, globalAutoApprove, activeProfile } = input;
  const perms = activeProfile?.permissions;
  if (perms?.blockedActions.includes(approval.actionType)) {
    return decision(
      false,
      "blocked_action",
      `Active profile blocks ${approval.actionType}.`,
    );
  }
  if (approval.policyEvaluation?.decision === "blocked") {
    return decision(
      false,
      "policy_blocked",
      `Policy blocked auto-approve: ${approval.policyEvaluation.reason}`,
    );
  }
  const budgetDecision = evaluateBudget({
    approval,
    profile: activeProfile,
    accumulatedTaskRunCostUsd: input.accumulatedTaskRunCostUsd,
    accumulatedDailyCostUsd: input.accumulatedDailyCostUsd,
  });
  if (budgetDecision.kind === "blocked") {
    return decision(
      false,
      "budget_blocked",
      budgetDecision.reason ?? "Profile budget blocks auto-approve.",
    );
  }
  if (perms?.autoApproveActions.includes(approval.actionType)) {
    return decision(
      true,
      "profile_auto_approve",
      `Active profile auto-approves ${approval.actionType}.`,
    );
  }
  if (approval.policyEvaluation?.allowAutoApprove === false) {
    return decision(
      false,
      "policy_disallow_auto",
      `Policy requires manual approval: ${approval.policyEvaluation.reason}`,
    );
  }
  if (
    input.workerFileActionAutoApprove === true &&
    input.isWorkerFileAction === true &&
    approval.actionType === "file_write"
  ) {
    return decision(
      true,
      "worker_file_action",
      "Worker file action auto-execution is enabled for this TaskRun.",
    );
  }
  return decision(
    globalAutoApprove,
    "global_toggle",
    globalAutoApprove
      ? "Global auto-approve is enabled."
      : "Global auto-approve is disabled.",
  );
};
