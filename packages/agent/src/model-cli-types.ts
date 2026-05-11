import type {
  AgentModelConfig,
  AgentProvider,
  AgentStreamEvent,
} from "@harness/core";

/**
 * Phase 8 — request envelope passed into ModelCliAdapter.invoke.
 * The adapter MUST treat `cwd` and `sandbox.primaryDir` as authoritative
 * and forbid the CLI from writing outside of them.
 */
export interface ModelCliRequest {
  invocationId: string;
  taskRunId: string;
  cwd: string;
  prompt: string;
  modelConfig: AgentModelConfig;
  sandbox: {
    primaryDir: string;
    /**
     * Always true at Phase 8: the prompt MUST contain the sandbox
     * statement so the model can't claim it wasn't told. The flag is
     * here to make the contract explicit at the call site.
     */
    enforceInPrompt: true;
  };
}

export interface ModelCliResult {
  provider: AgentProvider;
  model: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  normalizedEvents: AgentStreamEvent[];
  latencyMs: number;
  costEstimate?: number;
}

/**
 * Phase 8 MVP uses a single CLI per provider. The adapter receives an
 * AgentStreamEvent emitter so the IPC layer can forward chunks to the
 * renderer through `events:agentStreamEvent` (secret-redacted upstream).
 *
 * The optional `signal` is wired through `AgentInvocationQueue` so the
 * adapter can react to cancellation: implementations MUST send SIGTERM
 * (then SIGKILL after a short grace) to the child process and reject
 * with `AgentCliError("AGENT_CANCELLED","aborted",...)`.
 */
export interface ModelCliAdapter {
  invoke(
    request: ModelCliRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ModelCliResult>;
}

export type AgentErrorKind =
  | "spawn_failed"
  | "aborted"
  | "stall"
  | "timeout"
  | "model_invalid"
  | "rate_limit"
  | "fatal";
