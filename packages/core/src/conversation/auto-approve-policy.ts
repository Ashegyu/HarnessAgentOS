import type { AgentPermissions } from "../types/agent-profile.ts";
import type { Approval } from "../types/approval.ts";

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
  approval: Pick<Approval, "actionType">;
  globalAutoApprove: boolean;
  activeProfile: AutoApproveActiveProfile | null;
}

/**
 * Decision rule — see docs/design/agent-detailed-settings.md §4.1 + §7:
 *
 *   1. If the active profile blocks the action type → false (block wins).
 *   2. If the active profile explicitly auto-approves the action → true.
 *   3. Otherwise fall back to the global `approval.autoApprove` toggle.
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
  if (perms?.autoApproveActions.includes(approval.actionType)) return true;
  return globalAutoApprove;
};
