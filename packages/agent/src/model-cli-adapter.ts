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
    const args = buildArgs(provider, model, request.sessionId);

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

    let child;
    try {
      child = spawn(provider, args, {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: { ...process.env },
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
        AGENT_SPAWN_FAILED,
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        reject(
          new AgentCliError(AGENT_SPAWN_FAILED, "spawn_failed", err.message),
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
        `${provider} exited with code ${exitCode}: ${stderr.trim().slice(0, 400)}`,
      );
    }

    const latencyMs = Date.now() - startedAt;
    // claude --output-format=stream-json emits one JSON object per line —
    // extract the final assistant text so downstream parsers see the same
    // shape as the legacy --print buffered output.
    const { text: finalText, sessionId } =
      provider === "claude"
        ? extractClaudeStreamPayload(stdout)
        : { text: stdout, sessionId: undefined };
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
      stderr,
      normalizedEvents: [],
      latencyMs,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }
}

const buildArgs = (
  provider: string,
  model: string,
  sessionId?: string,
): string[] => {
  if (provider === "claude") {
    // Streaming output: emits one JSON line per chunk so the stall timer
    // sees regular activity. Without this, `--print` buffers the entire
    // response and stdout stays empty until completion — any non-trivial
    // prompt then trips the stall detector.
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", model,
    ];
    // Resume an existing conversation when a session id is provided so
    // follow-up questions within a thread share prior turns. Otherwise
    // claude assigns a fresh session id we pick up from the result line.
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    // --bare disables OAuth/keychain reads; only add it when ANTHROPIC_API_KEY
    // is present so users who authenticated via browser (OAuth) aren't blocked.
    if (process.env["ANTHROPIC_API_KEY"]) {
      args.splice(1, 0, "--bare");
    }
    return args;
  }
  // codex
  return ["exec", "--model", model];
};

/**
 * Parse claude --output-format=stream-json output and extract the final
 * assistant text plus the session id. The stream emits one JSON object
 * per line; the last `type: "result"` line carries `.result` and
 * `.session_id`. As a fallback we concatenate `text_delta` chunks so
 * partial output is still recoverable if the run is killed early.
 */
const extractClaudeStreamPayload = (
  rawStdout: string,
): { text: string; sessionId?: string } => {
  if (!rawStdout) return { text: "" };
  let resultText: string | null = null;
  let sessionId: string | undefined;
  const deltas: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj["type"] === "result" && typeof obj["result"] === "string") {
        resultText = obj["result"] as string;
      }
      if (typeof obj["session_id"] === "string") {
        sessionId = obj["session_id"] as string;
      }
      if (obj["type"] === "stream_event") {
        const ev = obj["event"] as Record<string, unknown> | undefined;
        const delta = ev?.["delta"] as Record<string, unknown> | undefined;
        if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          deltas.push(delta["text"] as string);
        }
      }
    } catch {
      // non-JSON line — ignore
    }
  }
  return {
    text: resultText ?? deltas.join(""),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
};
