import type { AgentPermissions } from "../types/agent-profile.ts";
import type { Approval } from "../types/approval.ts";
import type { Checkpoint } from "../types/checkpoint.ts";

/**
 * Stable surface for the renderer-side auto-approver. Only the fields the
 * policy looks at are required, so the caller can pass either a full
 * AgentProfile or a small stub.
 */
export interface AutoApproveActiveProfile {
  permissions: Pick<
    AgentPermissions,
    "autoApproveActions" | "blockedActions"
  >;
}

export interface ShouldAutoApproveInput {
  approval: Pick<Approval, "actionType" | "policyEvaluation">;
  globalAutoApprove: boolean;
  activeProfile: AutoApproveActiveProfile | null;
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
 *   3. If the active profile explicitly auto-approves the action → true.
 *   4. If service-layer policy disallows auto-approve → false.
 *   5. If narrow worker-file automation applies → true.
 *   6. Otherwise fall back to the global `approval.autoApprove` toggle.
 *
 * The block list takes priority over both per-profile auto-approve and
 * the global toggle so a "trust everything" boot can't bypass an
 * explicit per-profile prohibition (e.g. for a production agent that
 * must never auto-execute `git_commit`).
 */
export const shouldAutoApprove = (input: ShouldAutoApproveInput): boolean => {
  const { approval, globalAutoApprove, activeProfile } = input;
  const perms = activeProfile?.permissions;
  if (perms?.blockedActions.includes(approval.actionType)) return false;
  if (approval.policyEvaluation?.decision === "blocked") return false;
  if (perms?.autoApproveActions.includes(approval.actionType)) return true;
  if (approval.policyEvaluation?.allowAutoApprove === false) return false;
  if (
    input.workerFileActionAutoApprove === true &&
    input.isWorkerFileAction === true &&
    approval.actionType === "file_write"
  ) {
    return true;
  }
  return globalAutoApprove;
};
