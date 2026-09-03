import {
  AGENT_ROLE_MODEL_DEFAULTS,
  DEFAULT_AGENT_PERMISSIONS,
  type AgentSettings,
  type WorkerProfile,
} from "@harness/core";
import type { CreateAgentProfileInput } from "../repositories/agent-profile-repository.ts";

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
    ...AGENT_ROLE_MODEL_DEFAULTS[wp.role],
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
