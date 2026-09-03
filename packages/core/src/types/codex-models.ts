/**
 * Codex model choices intentionally exposed by HarnessAgentOS.
 *
 * Keep this catalogue small and explicit: settings, profiles, persistence,
 * and the CLI adapter all consume the same values so a retired model cannot
 * re-enter through a free-text field or a legacy database row.
 */
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number];

export const DEFAULT_CODEX_MODEL: CodexModel = "gpt-5.6-sol";

export const AGENT_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort =
  (typeof AGENT_REASONING_EFFORTS)[number];

export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";

const CODEX_MODEL_SET: ReadonlySet<string> = new Set(CODEX_MODELS);
const REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  AGENT_REASONING_EFFORTS,
);

export const isCodexModel = (value: unknown): value is CodexModel =>
  typeof value === "string" && CODEX_MODEL_SET.has(value.trim().toLowerCase());

export const normalizeCodexModel = (value: unknown): CodexModel => {
  if (typeof value !== "string") return DEFAULT_CODEX_MODEL;
  const normalized = value.trim().toLowerCase();
  return CODEX_MODEL_SET.has(normalized)
    ? (normalized as CodexModel)
    : DEFAULT_CODEX_MODEL;
};

export const isAgentReasoningEffort = (
  value: unknown,
): value is AgentReasoningEffort =>
  typeof value === "string" && REASONING_EFFORT_SET.has(value);

export const normalizeAgentReasoningEffort = (
  value: unknown,
): AgentReasoningEffort =>
  isAgentReasoningEffort(value) ? value : DEFAULT_AGENT_REASONING_EFFORT;
