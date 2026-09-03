import type {
  AgentReasoningEffort,
  CodexModel,
} from "./codex-models.ts";
import type { WorkerRole } from "./orchestration.ts";

export interface AgentRoleModelDefault {
  readonly model: CodexModel;
  readonly reasoningEffort: AgentReasoningEffort;
}

/**
 * Codex model defaults by workload. This is a cold-path profile policy, not
 * dynamic routing: users can still override any already-supported model on a
 * custom profile. Seeded and legacy unsupported profiles use this baseline.
 */
export const AGENT_ROLE_MODEL_DEFAULTS = {
  planner: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  coder: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  reviewer: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  tester: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  orchestrator: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  "security-reviewer": { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  "build-error-resolver": {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  },
  "refactor-cleaner": { model: "gpt-5.6-terra", reasoningEffort: "high" },
  "performance-reviewer": {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
  documenter: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
} as const satisfies Readonly<Record<WorkerRole, AgentRoleModelDefault>>;
