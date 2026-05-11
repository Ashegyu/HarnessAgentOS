import { spawn } from "node:child_process";
import type { AgentStreamEvent } from "@harness/core";
import { AgentCliError } from "./model-cli-errors";
import type {
  ModelCliAdapter,
  ModelCliRequest,
  ModelCliResult,
} from "./model-cli-types";

/**
 * Phase 8 default ModelCliAdapter.
 *
 * - `claude` is invoked with `--print` so output is captured non-interactively.
 * - `codex` is invoked with `exec` per the OpenAI Codex CLI v0.x contract.
 *
 * Both flows feed the prompt via stdin. timeoutMs and stallTimeoutMs come
 * from AgentModelConfig — exceeding either yields an AgentCliError.
 *
 * Phase 8 MVP does NOT implement provider-specific streaming protocols —
 * the renderer sees raw stdout chunks as `raw` events, plus a synthetic
 * `assistant_text` event at the end with the full text (already redacted
 * upstream by the IPC layer). Streaming-aware variants are a Phase 9+
 * refinement.
 */
export class DefaultModelCliAdapter implements ModelCliAdapter {
  async invoke(
    request: ModelCliRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ModelCliResult> {
    const { provider, model, timeoutMs, stallTimeoutMs } = request.modelConfig;
    const startedAt = Date.now();
    const args = buildArgs(provider, model);

    if (signal?.aborted) {
      throw new AgentCliError(
        "AGENT_CANCELLED",
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

    let child;
    try {
      child = spawn(provider, args, {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (e) {
      throw new AgentCliError(
        "AGENT_SPAWN_FAILED",
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    let stdout = "";
    let stderr = "";
    let lastChunkAt = Date.now();
    let killedByUs = false;
    let killReason: "timeout" | "stall" | "aborted" | null = null;

    const overallTimer = setTimeout(() => {
      killReason = "timeout";
      killedByUs = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > stallTimeoutMs) {
        killReason = "stall";
        killedByUs = true;
        child.kill("SIGKILL");
      }
    }, Math.min(1_000, stallTimeoutMs));

    const onAbort = (): void => {
      killReason = "aborted";
      killedByUs = true;
      // SIGTERM first; if the child ignores it the SIGKILL fallback fires
      // 2s later. SIGKILL is unconditional cleanup.
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore — child may already be exiting
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2_000);
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
    });

    try {
      child.stdin?.end(request.prompt, "utf8");
    } catch (e) {
      clearTimeout(overallTimer);
      clearInterval(stallTimer);
      throw new AgentCliError(
        "AGENT_SPAWN_FAILED",
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        reject(
          new AgentCliError("AGENT_SPAWN_FAILED", "spawn_failed", err.message),
        );
      });
      child.on("close", (code) => {
        clearTimeout(overallTimer);
        clearInterval(stallTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(code ?? -1);
      });
    });

    if (killedByUs && killReason === "timeout") {
      throw new AgentCliError(
        "AGENT_TIMEOUT",
        "timeout",
        `CLI exceeded ${timeoutMs}ms total timeout`,
      );
    }
    if (killedByUs && killReason === "stall") {
      throw new AgentCliError(
        "AGENT_STALL",
        "stall",
        `CLI produced no output for ${stallTimeoutMs}ms`,
      );
    }
    if (killedByUs && killReason === "aborted") {
      throw new AgentCliError(
        "AGENT_CANCELLED",
        "aborted",
        "Invocation cancelled by user",
      );
    }

    if (exitCode !== 0) {
      throw new AgentCliError(
        "AGENT_PROVIDER_UNAVAILABLE",
        "fatal",
        `${provider} exited with code ${exitCode}: ${stderr.trim().slice(0, 400)}`,
      );
    }

    const latencyMs = Date.now() - startedAt;
    onEvent({
      type: "assistant_text",
      invocationId: request.invocationId,
      text: stdout,
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
      stdout,
      stderr,
      normalizedEvents: [],
      latencyMs,
    };
  }
}

const buildArgs = (provider: string, model: string): string[] => {
  if (provider === "claude") {
    return ["--print", "--model", model];
  }
  // codex
  return ["exec", "--model", model];
};
