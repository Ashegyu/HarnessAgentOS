import { spawn } from "node:child_process";
import {
  AGENT_CANCELLED,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_SPAWN_FAILED,
  AGENT_STALL,
  AGENT_TIMEOUT,
  type AgentStreamEvent,
} from "@harness/core";
import { AgentCliError } from "./model-cli-errors.ts";
import type {
  ModelCliAdapter,
  ModelCliRequest,
  ModelCliResult,
} from "./model-cli-types.ts";
import {
  buildCliInvocation,
  extractProviderPayload,
  formatProviderExitFailure,
} from "./model-cli-invocation.ts";
import { resolveProviderCommand } from "./provider-executable.ts";
import { ProviderToolCallStreamParser } from "./provider-tool-call-events.ts";

const DEFAULT_ABORT_KILL_GRACE_MS = 2_000;

export interface DefaultModelCliAdapterDeps {
  spawn?: typeof spawn;
  abortKillGraceMs?: number;
}

/**
 * Phase 8 default ModelCliAdapter.
 *
 * - `claude` is invoked with `--print` so output is captured non-interactively.
 * - `codex` is invoked with `exec --json ... -` per the Codex CLI contract.
 *
 * Both flows feed the prompt via stdin. Claude receives the system prompt
 * through `--system-prompt`; Codex has no equivalent flag, so the adapter
 * folds system instructions into the stdin prompt. timeoutMs and stallTimeoutMs come
 * from AgentModelConfig — exceeding either yields an AgentCliError.
 *
 * The renderer sees raw stdout chunks as `raw` events, plus a synthetic
 * `assistant_text` event at the end with the full text (already redacted
 * upstream by the IPC layer). The following `result` event is what commits
 * that assistant text as final in the UI.
 */
export class DefaultModelCliAdapter implements ModelCliAdapter {
  private readonly spawn: typeof spawn;
  private readonly abortKillGraceMs: number;

  constructor(deps: DefaultModelCliAdapterDeps = {}) {
    this.spawn = deps.spawn ?? spawn;
    this.abortKillGraceMs =
      deps.abortKillGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS;
  }

  async invoke(
    request: ModelCliRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ModelCliResult> {
    const { provider, model, timeoutMs, stallTimeoutMs } = request.modelConfig;
    const startedAt = Date.now();
    const invocation = buildCliInvocation(request);
    const command = resolveProviderCommand(provider, request.cliPathOverride);

    if (signal?.aborted) {
      throw new AgentCliError(
        AGENT_CANCELLED,
        "aborted",
        "Invocation cancelled before spawn",
      );
    }

    onEvent({
      type: "started",
      invocationId: request.invocationId,
      provider,
      model,
    });

    let child: ReturnType<typeof spawn>;
    try {
      child = this.spawn(command, invocation.args, {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: { ...process.env },
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new AgentCliError(
        AGENT_SPAWN_FAILED,
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    let stdout = "";
    let stderr = "";
    const normalizedEvents: AgentStreamEvent[] = [];
    const stdoutToolCalls = new ProviderToolCallStreamParser({
      invocationId: request.invocationId,
      provider,
      source: "stdout",
    });
    const stderrToolCalls = new ProviderToolCallStreamParser({
      invocationId: request.invocationId,
      provider,
      source: "stderr",
    });
    const emitNormalizedEvents = (events: AgentStreamEvent[]): void => {
      for (const event of events) {
        normalizedEvents.push(event);
        onEvent(event);
      }
    };
    let lastChunkAt = Date.now();
    let killedByUs = false;
    let killReason: "timeout" | "stall" | "aborted" | null = null;
    let overallTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let abortFallbackTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let onAbort: () => void = () => {};

    const cleanup = (options?: { clearAbortFallback?: boolean }): void => {
      if (overallTimer) clearTimeout(overallTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (options?.clearAbortFallback !== false && abortFallbackTimer) {
        clearTimeout(abortFallbackTimer);
      }
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    overallTimer = setTimeout(() => {
      killReason = "timeout";
      killedByUs = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > stallTimeoutMs) {
        killReason = "stall";
        killedByUs = true;
        child.kill("SIGKILL");
      }
    }, Math.min(1_000, stallTimeoutMs));

    onAbort = (): void => {
      if (killReason === "aborted") return;
      killReason = "aborted";
      killedByUs = true;
      // SIGTERM first; if the child ignores it the SIGKILL fallback fires
      // 2s later. SIGKILL is unconditional cleanup.
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may already be exiting
      }
      abortFallbackTimer = setTimeout(() => {
        if (closed) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, this.abortKillGraceMs);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      stdout += text;
      lastChunkAt = Date.now();
      onEvent({
        type: "raw",
        invocationId: request.invocationId,
        source: "stdout",
        text,
      });
      emitNormalizedEvents(stdoutToolCalls.feed(text));
    });
    child.stderr?.on("data", (b: Buffer) => {
      const text = b.toString("utf8");
      stderr += text;
      lastChunkAt = Date.now();
      onEvent({
        type: "raw",
        invocationId: request.invocationId,
        source: "stderr",
        text,
      });
      emitNormalizedEvents(stderrToolCalls.feed(text));
    });

    try {
      child.stdin?.end(invocation.stdin, "utf8");
    } catch (e) {
      cleanup();
      throw new AgentCliError(
        AGENT_SPAWN_FAILED,
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        if (killReason === "aborted" || signal?.aborted) {
          cleanup({ clearAbortFallback: false });
          reject(
            new AgentCliError(
              AGENT_CANCELLED,
              "aborted",
              "Invocation cancelled by user",
            ),
          );
          return;
        }
        cleanup();
        reject(new AgentCliError(AGENT_SPAWN_FAILED, "spawn_failed", err.message));
      });
      child.on("close", (code) => {
        closed = true;
        cleanup();
        resolve(code ?? -1);
      });
    });
    emitNormalizedEvents(stdoutToolCalls.flush());
    emitNormalizedEvents(stderrToolCalls.flush());

    if (killedByUs && killReason === "timeout") {
      throw new AgentCliError(
        AGENT_TIMEOUT,
        "timeout",
        `CLI exceeded ${timeoutMs}ms total timeout`,
      );
    }
    if (killedByUs && killReason === "stall") {
      throw new AgentCliError(
        AGENT_STALL,
        "stall",
        `CLI produced no output for ${stallTimeoutMs}ms`,
      );
    }
    if (killedByUs && killReason === "aborted") {
      throw new AgentCliError(
        AGENT_CANCELLED,
        "aborted",
        "Invocation cancelled by user",
      );
    }

    if (exitCode !== 0) {
      throw new AgentCliError(
        AGENT_PROVIDER_UNAVAILABLE,
        "fatal",
        formatProviderExitFailure(provider, exitCode, stdout, stderr),
      );
    }

    const latencyMs = Date.now() - startedAt;
    // claude --output-format=stream-json emits one JSON object per line —
    // extract the final assistant text so downstream parsers see the same
    // shape as the legacy --print buffered output.
    const { text: finalText, sessionId } = extractProviderPayload(
      provider,
      stdout,
    );
    onEvent({
      type: "assistant_text",
      invocationId: request.invocationId,
      text: finalText,
    });
    onEvent({
      type: "result",
      invocationId: request.invocationId,
      latencyMs,
    });

    return {
      provider,
      model,
      exitCode,
      stdout: finalText,
      rawStdout: stdout,
      stderr,
      normalizedEvents,
      latencyMs,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }
}
