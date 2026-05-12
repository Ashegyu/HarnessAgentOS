import type {
  AgentModelTuning,
  AgentProfile,
  AgentSettings,
} from "@harness/core";

/**
 * Result of resolving "which AgentProfile (if any) should drive this
 * invocation". Always returns a usable `tuning` block: either the
 * winning profile's tuning, or one synthesized from the legacy global
 * `AgentSettings` so callers never need a null check.
 */
export interface ResolvedAgentProfile {
  /** Provenance — useful for logs / telemetry, never for security gating. */
  source: "active" | "default" | "legacy";
  /** The full profile when one won; null when the legacy fallback ran. */
  profile: AgentProfile | null;
  tuning: AgentModelTuning;
  persona: string;
  systemPromptPrefix: string;
  systemPromptSuffix: string;
}

export interface ResolveAgentProfileInput {
  profiles: readonly AgentProfile[];
  activeAgentProfileId: string | undefined;
  legacyAgent: Pick<
    AgentSettings,
    "model" | "timeoutMs" | "stallTimeoutMs" | "contextDepth"
  >;
}

/**
 * Pure resolver — see docs/design/agent-detailed-settings.md §8.2.
 *
 * Priority order: explicit active → row carrying isDefault=true → legacy
 * `HarnessSettings.agent` block. Tests rely on these provenance markers
 * to detect silent migration regressions.
 */
export const resolveAgentProfile = (
  input: ResolveAgentProfileInput,
): ResolvedAgentProfile => {
  const { profiles, activeAgentProfileId, legacyAgent } = input;

  // 1. Explicit active id wins when it actually points to a known row.
  if (activeAgentProfileId) {
    const active = profiles.find((p) => p.id === activeAgentProfileId);
    if (active) return surfaceProfile(active, "active");
    // Fall through — stale id (deleted row, copy-pasted from another
    // installation, etc.) should not hang invocation.
  }

  // 2. isDefault row (at most one by the partial unique index).
  const defaultProfile = profiles.find((p) => p.isDefault);
  if (defaultProfile) return surfaceProfile(defaultProfile, "default");

  // 3. Legacy fallback — synthesize a tuning block from the global agent
  // settings so callers don't have to special-case the null path.
  return {
    source: "legacy",
    profile: null,
    tuning: {
      model: legacyAgent.model,
      timeoutMs: legacyAgent.timeoutMs,
      stallTimeoutMs: legacyAgent.stallTimeoutMs,
      contextDepth: legacyAgent.contextDepth,
      systemPromptPrefix: "",
      systemPromptSuffix: "",
    },
    persona: "",
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  };
};

const surfaceProfile = (
  profile: AgentProfile,
  source: "active" | "default",
): ResolvedAgentProfile => ({
  source,
  profile,
  tuning: profile.tuning,
  persona: profile.persona,
  systemPromptPrefix: profile.tuning.systemPromptPrefix,
  systemPromptSuffix: profile.tuning.systemPromptSuffix,
});
