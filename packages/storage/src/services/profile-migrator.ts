import {
  DEFAULT_AGENT_PERMISSIONS,
  DEFAULT_CODEX_MODEL,
  type AgentSettings,
  type WorkerProfile,
} from "@harness/core";
import type { CreateAgentProfileInput } from "../repositories/agent-profile-repository.ts";

const codexMigrationModel = (model: string): string => {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0 || lower === "gpt-5" || lower.startsWith("claude")) {
    return DEFAULT_CODEX_MODEL;
  }
  return trimmed;
};

const CODEX_MIGRATION_REASONING_EFFORT = "xhigh";

/**
 * Lossy conversion from the legacy `WorkerProfile` shape to a full
 * AgentProfile input. The legacy row only carries identity + model;
 * tuning falls back to the global `AgentSettings`, persona is empty,
 * permissions default to "no auto-approve, no blocks". See
 * docs/design/agent-detailed-settings.md §8.1.
 */
export const workerProfileToAgentProfileInput = (
  wp: WorkerProfile,
  legacyAgent: Pick<
    AgentSettings,
    "timeoutMs" | "stallTimeoutMs" | "contextDepth"
  >,
  opts: { isDefault?: boolean } = {},
): CreateAgentProfileInput => ({
  name: wp.name,
  description: "",
  category: "legacy",
  tags: ["legacy-worker", wp.role],
  provider: "codex",
  role: wp.role,
  persona: "",
  tuning: {
    model: codexMigrationModel(wp.model),
    reasoningEffort: CODEX_MIGRATION_REASONING_EFFORT,
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
  isDefault: opts.isDefault ?? false,
});
