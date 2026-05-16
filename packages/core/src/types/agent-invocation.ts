/**
 * Phase 8 — Agent invocation row.
 * Persisted in the SQLite `agent_invocations` table; one row per CLI run.
 */
export type AgentProvider = "claude" | "codex";

export interface CreateAgentInvocationInput {
  taskRunId: string;
  provider: AgentProvider;
  model: string;
  promptArtifactId: string;
  stepId?: string;
}

export interface UpdateAgentInvocationPatch {
  status?: AgentInvocationStatus;
  stepId?: string;
  rawOutputArtifactId?: string | null;
  parsedPlanArtifactId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  latencyMs?: number | null;
  costEstimate?: number | null;
}

export type AgentInvocationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AgentModelConfig {
  provider: AgentProvider;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  timeoutMs: number;
  stallTimeoutMs: number;
}

export interface AgentInvocation {
  id: string;
  taskRunId: string;
  stepId?: string;
  provider: AgentProvider;
  model: string;
  status: AgentInvocationStatus;
  promptArtifactId: string;
  rawOutputArtifactId?: string;
  parsedPlanArtifactId?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  costEstimate?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProviderProbe {
  available: boolean;
  version?: string;
  error?: string;
  /**
   * Phase 8 — in-process invocation queue depth for this provider,
   * including any in-flight invocation. RuntimeStatusBar surfaces this
   * so the user can tell when a request is waiting behind another.
   * Defaults to 0 when reported by a standalone probe (no queue wired).
   */
  queueDepth: number;
}

export interface AgentProviderStatusMap {
  claude: AgentProviderProbe;
  codex: AgentProviderProbe;
}

export type AgentProgressStage =
  | "context"
  | "profile"
  | "prompt"
  | "session"
  | "mcp"
  | "queued"
  | "cli"
  | "parse"
  | "approval"
  | "complete";

export interface AgentProgressEvent {
  type: "progress";
  invocationId: string;
  taskRunId: string;
  stage: AgentProgressStage;
  message: string;
  detail?: string;
  at: string;
}

/**
 * Stream chunks normalized across providers. Renderer subscribes to
 * `events:agentStreamEvent` and filters by `invocationId`.
 */
export type AgentStreamEvent =
  | AgentProgressEvent
  | {
      type: "started";
      invocationId: string;
      provider: AgentProvider;
      model: string;
    }
  | {
      /**
       * Completed assistant text observed before the app-level invocation
       * result is committed. Renderers should treat it as intermediate until
       * a `result` event arrives or the invocation reaches a terminal status.
       */
      type: "assistant_text";
      invocationId: string;
      text: string;
    }
  | {
      type: "raw";
      invocationId: string;
      source: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "result";
      invocationId: string;
      latencyMs?: number;
      costEstimate?: number;
      usage?: Record<string, unknown>;
      usageApproximate?: boolean;
      costEstimateApproximate?: boolean;
    }
  | {
      type: "failed";
      invocationId: string;
      errorCode: string;
      message: string;
    }
  | { type: "cancelled"; invocationId: string };
