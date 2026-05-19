import type {
  AgentModelConfig,
  AgentProvider,
  AgentStreamEvent,
} from "@harness/core";

export interface ModelCliToolPolicy {
  /**
   * Provider-facing tool patterns derived from AgentProfile permissions.
   * Claude maps these to `--allowedTools`; Codex currently has no verified
   * `exec` equivalent, so the adapter does not pass them there.
   */
  toolAllowlist: readonly string[];
  /** Deny patterns remain higher priority in Harness policy and provider flags. */
  toolDenylist: readonly string[];
}

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
  /**
   * Optional Claude CLI session UUID. When unset, the adapter starts a
   * new session and the caller MUST read `result.sessionId` to persist
   * it for follow-ups. When set, the adapter passes `--resume <uuid>`
   * so the conversation continues with full prior context.
   */
  sessionId?: string;
  /**
   * Claude: passed via `--system-prompt` so the model receives it in
   * the system channel. Codex CLI has no equivalent flag in `exec`,
   * so the adapter folds it into the stdin prompt before the user request.
   */
  systemPrompt?: string;
  /**
   * Absolute path to a `.mcp.json` file (see `mcp-config-builder.ts`).
   * Passed as `--mcp-config <path>` to Claude CLI; ignored for Codex
   * until V2 verification of `codex exec --mcp-config` lands.
   * Main process is expected to write the file to a temp location for
   * the invocation and delete it after the run completes.
   */
  mcpConfigPath?: string;
  /**
   * Optional tool policy from the selected AgentProfile. This is an
   * execution-boundary hint only: unsupported providers must ignore it
   * rather than invent unverified flags.
   */
  toolPolicy?: ModelCliToolPolicy;
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
  latencyMs: number;
  costEstimate?: number;
  /** Session UUID the CLI used or created. Stable across `--resume`. */
  sessionId?: string;
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
