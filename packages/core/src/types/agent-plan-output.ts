/**
 * Phase 8 — Agent CLI integration.
 * Source: docs/implementation/phase-08-agent-cli-integration.md (#4 Output 계약).
 *
 * Renderer-facing shape: the parser emits this after schema validation,
 * but **before** runner policy (path traversal, dangerous shell command,
 * high-risk action class) is applied — that happens in AgentPlanningService
 * just before approval rows are created.
 */
export type AgentProposedAction =
  | {
      type: "file_write";
      path: string;
      before?: string;
      after: string;
      rationale: string;
    }
  | {
      type: "shell";
      command: string;
      args?: string[];
      rationale: string;
    };

export interface AgentPlanStep {
  title: string;
  rationale: string;
  risk: "low" | "medium" | "high";
}

export interface AgentSuggestedQualityCheck {
  command: string;
  reason: string;
}

export interface AgentPlanOutput {
  summary: string;
  assumptions: string[];
  steps: AgentPlanStep[];
  proposedActions: AgentProposedAction[];
  suggestedQualityChecks: AgentSuggestedQualityCheck[];
  /** Compatibility field. Agent runs are non-interactive, so this is normalized to []. */
  questions: string[];
}
