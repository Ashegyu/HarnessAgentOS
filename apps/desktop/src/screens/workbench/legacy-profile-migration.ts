import type {
  AgentProfile,
  AgentSettings,
  WorkerProfile,
} from "@harness/core";
import { DEFAULT_AGENT_PERMISSIONS } from "@harness/core";

/**
 * Renderer-side mirror of packages/storage/src/services/profile-migrator.ts.
 * Kept here because the renderer can't import @harness/storage (it pulls
 * in better-sqlite3 native bindings). Behavior matches the storage
 * helper one-for-one; the storage test is the canonical contract.
 */
export type CreateAgentProfilePayload = Omit<
  AgentProfile,
  "id" | "createdAt" | "updatedAt"
>;

export interface MigrationPlanInput {
  /** Legacy global agent block, used when a worker omits per-row tuning. */
  legacyAgent: Pick<
    AgentSettings,
    "model" | "timeoutMs" | "stallTimeoutMs" | "contextDepth"
  >;
  /** Legacy worker rows. Empty when the user never enabled orchestration. */
  workerProfiles: readonly WorkerProfile[];
  /**
   * Existing AgentProfile rows. The migration is a no-op when this is
   * non-empty so we never overwrite hand-tuned data.
   */
  existingProfiles: readonly AgentProfile[];
}

export interface MigrationPlan {
  /** What we're going to do, shown to the user before they confirm. */
  description: string;
  /** Inputs ready to feed `agents.create`. First one carries isDefault=true. */
  inputs: readonly CreateAgentProfilePayload[];
}

const workerToInput = (
  wp: WorkerProfile,
  legacyAgent: MigrationPlanInput["legacyAgent"],
  isDefault: boolean,
): CreateAgentProfilePayload => ({
  name: wp.name,
  description: "",
  provider: wp.provider,
  role: wp.role,
  persona: "",
  tuning: {
    model: wp.model,
    timeoutMs: legacyAgent.timeoutMs,
    stallTimeoutMs: legacyAgent.stallTimeoutMs,
    contextDepth: legacyAgent.contextDepth,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [...DEFAULT_AGENT_PERMISSIONS.autoApproveActions],
    blockedActions: [...DEFAULT_AGENT_PERMISSIONS.blockedActions],
    allowedSkillIds: [...DEFAULT_AGENT_PERMISSIONS.allowedSkillIds],
    toolAllowlist: [...DEFAULT_AGENT_PERMISSIONS.toolAllowlist],
    toolDenylist: [...DEFAULT_AGENT_PERMISSIONS.toolDenylist],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault,
});

const legacyAgentSeedInput = (
  legacyAgent: MigrationPlanInput["legacyAgent"] & {
    provider?: AgentProfile["provider"];
  },
): CreateAgentProfilePayload => ({
  name: "Default agent (마이그레이션)",
  description: "기존 글로벌 agent 설정에서 자동 생성",
  provider: legacyAgent.provider ?? "auto",
  role: "coder",
  persona: "",
  tuning: {
    model: legacyAgent.model,
    timeoutMs: legacyAgent.timeoutMs,
    stallTimeoutMs: legacyAgent.stallTimeoutMs,
    contextDepth: legacyAgent.contextDepth,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: { cliPathOverride: "", env: {}, envSecretRefs: {} },
  permissions: {
    autoApproveActions: [...DEFAULT_AGENT_PERMISSIONS.autoApproveActions],
    blockedActions: [...DEFAULT_AGENT_PERMISSIONS.blockedActions],
    allowedSkillIds: [...DEFAULT_AGENT_PERMISSIONS.allowedSkillIds],
    toolAllowlist: [...DEFAULT_AGENT_PERMISSIONS.toolAllowlist],
    toolDenylist: [...DEFAULT_AGENT_PERMISSIONS.toolDenylist],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: true,
});

/**
 * Build a migration plan. Returns `null` when there's nothing to migrate
 * — either the user already has AgentProfile rows (we never overwrite),
 * or they have no legacy data at all.
 *
 * Otherwise:
 *  - If they have WorkerProfile[] entries, one AgentProfile per row
 *    (first marked isDefault).
 *  - Else if their legacy global `agent.model` is non-empty, a single
 *    "Default agent" profile seeded from the global block.
 *  - Else null (nothing meaningful to migrate).
 */
export const planLegacyMigration = (
  input: MigrationPlanInput,
): MigrationPlan | null => {
  if (input.existingProfiles.length > 0) return null;

  const workers = input.workerProfiles;
  if (workers.length > 0) {
    const inputs = workers.map((wp, i) =>
      workerToInput(wp, input.legacyAgent, i === 0),
    );
    return {
      description:
        `Orchestration Worker Profile ${workers.length}개를 새 ` +
        `Agent Profile로 변환합니다. 첫 번째 행이 default가 됩니다.`,
      inputs,
    };
  }

  // No worker rows; fall back to a single seed from the legacy global
  // agent block, but only when there's something non-default in it.
  const hasNonDefault =
    input.legacyAgent.model.trim().length > 0 ||
    input.legacyAgent.timeoutMs !== 300_000 ||
    input.legacyAgent.stallTimeoutMs !== 60_000 ||
    input.legacyAgent.contextDepth !== 5;
  if (!hasNonDefault) return null;

  return {
    description:
      "기존 글로벌 agent 설정을 'Default agent' 프로필로 변환합니다.",
    inputs: [legacyAgentSeedInput(input.legacyAgent)],
  };
};
