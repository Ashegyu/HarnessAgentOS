import type {
  AgentModelConfig,
  AgentProvider,
  AgentStreamEvent,
} from "@harness/core";

export type ModelCliSandboxMode = "read-only" | "workspace-write";

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
    mode?: ModelCliSandboxMode;
    autoReview?: boolean;
    /**
     * Always true at Phase 8: the prompt MUST contain the sandbox
     * statement so the model can't claim it wasn't told. The flag is
     * here to make the contract explicit at the call site.
     */
    enforceInPrompt: true;
  };
  /**
   * Codex CLI has no separate system-prompt flag in `exec`, so the adapter
   * folds this block into stdin before the user request.
   */
  systemPrompt?: string;
  /**
   * Codex per-run config overrides passed as repeated `-c <key=value>`
   * flags before `exec`. Used for verified `mcp_servers.*` settings only.
   * Do not include plaintext secrets here because argv can be inspected.
   */
  codexConfigOverrides?: readonly string[];
  /**
   * Absolute executable override from AgentProfile.cli.cliPathOverride.
   * When unset, the adapter resolves a provider-specific default command.
   */
  cliPathOverride?: string;
}

export interface ModelCliResult {
  provider: AgentProvider;
  model: string;
  exitCode: number;
  /**
   * Extracted assistant text. Downstream parsers use this for the
   * harness_agent_plan contract.
   */
  stdout: string;
  /**
   * Original provider stdout before payload extraction. UI persistence
   * uses this so completed TaskRuns can be rehydrated into the same
   * thinking/tool/intermediate/final sections as the live stream.
   */
  rawStdout?: string;
  stderr: string;
  normalizedEvents: AgentStreamEvent[];
  /** Bytes/events dropped from bounded in-memory buffers during a long run. */
  truncation?: {
    stdoutDroppedBytes: number;
    stderrDroppedBytes: number;
    normalizedEventsDropped: number;
  };
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
