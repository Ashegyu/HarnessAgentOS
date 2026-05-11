export type AgentProvider = "auto" | "claude" | "codex";

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  timeoutMs: number;
  stallTimeoutMs: number;
  contextDepth: number;
}

export interface HarnessSettings {
  agent: AgentSettings;
}

export const DEFAULT_HARNESS_SETTINGS: Readonly<HarnessSettings> =
  Object.freeze({
    agent: Object.freeze({
      provider: "auto" as AgentProvider,
      model: "",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
    }),
  });
