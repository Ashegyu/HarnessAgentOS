import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  AGENT_CANCELLED,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_SPAWN_FAILED,
  AGENT_STALL,
  AGENT_TIMEOUT,
  TASK_CONTRACT_PREFLIGHT_FAILED,
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
  formatProviderExitFailure,
} from "./model-cli-invocation.ts";
import { resolveProviderCommand } from "./provider-executable.ts";
import { ProviderToolCallStreamParser, extractProviderToolCallsFromEvent } from "./provider-tool-call-events.ts";
import { CodexExecStream } from "./codex-exec-stream.ts";
import { buildAgentOutputSchema, normalizeStructuredAgentOutput } from "./agent-output-schema.ts";
import { prepareCodexOutputSchema, type CodexOutputSchemaInput, type PreparedCodexOutputSchema } from "./codex-output-schema.ts";
import { terminateWindowsProcessTree } from "./owned-process-tree.ts";
import { readCodexMcpServerNames, type CodexMcpInventoryInput } from "./codex-read-only-preflight.ts";
import {
  BoundedAgentStreamEventBuffer,
  BoundedTextBuffer,
  DEFAULT_MAX_CLI_STDERR_BYTES,
  DEFAULT_MAX_CLI_STDOUT_BYTES,
  DEFAULT_MAX_NORMALIZED_EVENTS,
} from "./agent-stream-limits.ts";

const DEFAULT_ABORT_KILL_GRACE_MS = 2_000;
const TRANSIENT_PARENT_CODEX_ENV = [
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

export interface DefaultModelCliAdapterDeps {
  spawn?: typeof spawn;
  prepareOutputSchema?: (input: CodexOutputSchemaInput) => Promise<PreparedCodexOutputSchema>;
  readMcpServerNames?: (input: CodexMcpInventoryInput) => Promise<readonly string[]>;
  abortKillGraceMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxNormalizedEvents?: number;
  maxJsonlFrameBytes?: number;
  maxFinalTextBytes?: number;
  platform?: NodeJS.Platform;
  terminateProcessTree?: (pid: number) => Promise<void>;
}

/**
 * Phase 8 default ModelCliAdapter.
 *
 * - `codex` is invoked with `exec --json ... -` per the Codex CLI contract.
 *
 * The prompt is fed via stdin. Codex has no dedicated system-prompt flag, so
 * the adapter folds system instructions into the stdin prompt. timeoutMs and stallTimeoutMs come
 * from AgentModelConfig — exceeding either yields an AgentCliError.
 *
 * The renderer sees raw stdout chunks as `raw` events, plus a synthetic
 * `assistant_text` event at the end with the full text (already redacted
 * upstream by the IPC layer). The following `result` event is what commits
 * that assistant text as final in the UI.
 */
export class DefaultModelCliAdapter implements ModelCliAdapter {
  private readonly spawn: typeof spawn;
  private readonly prepareOutputSchema: (input: CodexOutputSchemaInput) => Promise<PreparedCodexOutputSchema>;
  private readonly readMcpServerNames: (input: CodexMcpInventoryInput) => Promise<readonly string[]>;
  private readonly abortKillGraceMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly maxNormalizedEvents: number;
  private readonly maxJsonlFrameBytes: number | undefined;
  private readonly maxFinalTextBytes: number | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly terminateProcessTree: (pid: number) => Promise<void>;

  constructor(deps: DefaultModelCliAdapterDeps = {}) {
    this.spawn = deps.spawn ?? spawn;
    this.prepareOutputSchema = deps.prepareOutputSchema ?? prepareCodexOutputSchema;
    this.platform = deps.platform ?? process.platform;
    this.terminateProcessTree = deps.terminateProcessTree ?? terminateWindowsProcessTree;
    this.maxJsonlFrameBytes = deps.maxJsonlFrameBytes;
    this.maxFinalTextBytes = deps.maxFinalTextBytes;
    this.readMcpServerNames = deps.readMcpServerNames ?? readCodexMcpServerNames;
    this.abortKillGraceMs =
      deps.abortKillGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS;
    this.maxStdoutBytes =
      deps.maxStdoutBytes ?? DEFAULT_MAX_CLI_STDOUT_BYTES;
    this.maxStderrBytes =
      deps.maxStderrBytes ?? DEFAULT_MAX_CLI_STDERR_BYTES;
    this.maxNormalizedEvents =
      deps.maxNormalizedEvents ?? DEFAULT_MAX_NORMALIZED_EVENTS;
  }

  async invoke(
    request: ModelCliRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ModelCliResult> {
    if (!request.outputContract || signal?.aborted) return this.invokePrepared(request, onEvent, signal);
    let prepared: PreparedCodexOutputSchema;
    try {
      prepared = await this.prepareOutputSchema({
        command: resolveProviderCommand(request.modelConfig.provider, request.cliPathOverride),
        cwd: request.cwd, env: buildProviderSpawnEnv(process.env),
        schema: buildAgentOutputSchema(request.outputContract), ...(signal ? { signal } : {}),
      });
    } catch {
      throw new AgentCliError(signal?.aborted ? AGENT_CANCELLED : TASK_CONTRACT_PREFLIGHT_FAILED,
        signal?.aborted ? "aborted" : "fatal", "CLI 출력 스키마 지원을 확인할 수 없어 실행을 중단했습니다. Codex CLI 버전과 실행 경로를 확인하세요.");
    }
    try {
      return await this.invokePrepared(request, onEvent, signal, prepared.path);
    } finally {
      try { await prepared.dispose(); }
      catch {
        // A leftover derived schema is a cleanup warning, not a replacement
        // for cancellation, process failure, or the validated model result.
        onEvent({ type: "raw", invocationId: request.invocationId, taskRunId: request.taskRunId,
          source: "stderr", text: "임시 스키마 파일 정리를 확인하지 못했습니다. 다른 파일은 삭제하지 않았습니다.\n" });
      }
    }
  }

  private async invokePrepared(
    request: ModelCliRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
    outputSchemaPath?: string,
  ): Promise<ModelCliResult> {
    const { provider, model, timeoutMs, stallTimeoutMs } = request.modelConfig;
    const startedAt = Date.now();
    const command = resolveProviderCommand(provider, request.cliPathOverride);

    if (signal?.aborted) {
      throw new AgentCliError(
        AGENT_CANCELLED,
        "aborted",
        "Invocation cancelled before spawn",
      );
    }

    let readOnlyMcpServerNames: readonly string[] | undefined;
    if (request.sandbox.readOnlyTask || request.sandbox.disableWebSearch) {
      try {
        readOnlyMcpServerNames = await this.readMcpServerNames({
          command, cwd: request.cwd, env: buildProviderSpawnEnv(process.env),
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new AgentCliError(signal?.aborted ? AGENT_CANCELLED : TASK_CONTRACT_PREFLIGHT_FAILED,
          signal?.aborted ? "aborted" : "fatal",
          "읽기 전용 도구 권한을 확인할 수 없어 실행을 중단했습니다. Codex CLI 상태를 확인하세요.");
      }
    }
    if (signal?.aborted) throw new AgentCliError(AGENT_CANCELLED, "aborted", "Invocation cancelled during preflight");
    const invocation = buildCliInvocation({ ...request,
      ...(readOnlyMcpServerNames ? { readOnlyMcpServerNames } : {}),
    }, outputSchemaPath);

    onEvent({
      type: "started",
      invocationId: request.invocationId,
      taskRunId: request.taskRunId,
      provider,
      model,
    });

    let child: ReturnType<typeof spawn>;
    try {
      child = this.spawn(command, invocation.args, {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: buildProviderSpawnEnv(process.env),
      });
    } catch (e) {
      throw new AgentCliError(
        AGENT_SPAWN_FAILED,
        "spawn_failed",
        e instanceof Error ? e.message : String(e),
      );
    }

    const stdoutBuffer = new BoundedTextBuffer(this.maxStdoutBytes);
    const stderrBuffer = new BoundedTextBuffer(this.maxStderrBytes);
    const normalizedEvents = new BoundedAgentStreamEventBuffer({
      maxEvents: this.maxNormalizedEvents,
      maxBytes: this.maxStdoutBytes,
    });
    const execStream = new CodexExecStream({
      ...(this.maxJsonlFrameBytes !== undefined ? { maxFrameBytes: this.maxJsonlFrameBytes } : {}),
      ...(this.maxFinalTextBytes !== undefined ? { maxFinalBytes: this.maxFinalTextBytes } : {}),
      onFrame: (event) => emitNormalizedEvents(extractProviderToolCallsFromEvent(event, {
        invocationId: request.invocationId, taskRunId: request.taskRunId, provider, source: "stdout",
      })),
    });
    const stderrDecoder = new StringDecoder("utf8");
    const stderrToolCalls = new ProviderToolCallStreamParser({
      invocationId: request.invocationId,
      taskRunId: request.taskRunId,
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
    let killReason: "timeout" | "stall" | "aborted" | "io_error" | null = null;
    let processError: Error | undefined;
    let treeCleanup: Promise<void> | undefined;
    let cleanupFailed = false;
    let overallTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let abortFallbackTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let onAbort: () => void = () => {};

    const clearWatchdogs = (): void => {
      if (overallTimer) clearTimeout(overallTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const killRoot = (terminationSignal: NodeJS.Signals): void => {
      try { child.kill(terminationSignal); }
      catch { cleanupFailed = true; }
    };
    const stopChild = (reason: NonNullable<typeof killReason>): void => {
      if (closed || killReason) return;
      killReason = reason;
      clearWatchdogs();
      if (this.platform === "win32" && child.pid !== undefined) {
        // Root-first kill loses Windows descendant ownership. Start tree cleanup first,
        // and keep the queue slot until both taskkill and the child's close complete.
        try { treeCleanup = this.terminateProcessTree(child.pid); }
        catch { treeCleanup = Promise.reject(new Error("Process tree cleanup failed")); }
        treeCleanup = treeCleanup.catch(() => {
          cleanupFailed = true;
          if (!closed) killRoot("SIGKILL");
        });
      } else {
        killRoot(reason === "aborted" ? "SIGTERM" : "SIGKILL");
        if (reason === "aborted" && !closed) {
          abortFallbackTimer = setTimeout(() => {
            if (!closed) killRoot("SIGKILL");
          }, this.abortKillGraceMs);
        }
      }
    };
    onAbort = () => stopChild("aborted");

    child.stdout?.on("data", (b: Buffer) => {
      const text = execStream.write(b);
      stdoutBuffer.append(text);
      lastChunkAt = Date.now();
      onEvent({
        type: "raw",
        invocationId: request.invocationId,
        taskRunId: request.taskRunId,
        source: "stdout",
        text,
      });
    });
    child.stderr?.on("data", (b: Buffer) => {
      const text = stderrDecoder.write(b);
      stderrBuffer.append(text);
      lastChunkAt = Date.now();
      onEvent({
        type: "raw",
        invocationId: request.invocationId,
        taskRunId: request.taskRunId,
        source: "stderr",
        text,
      });
      emitNormalizedEvents(stderrToolCalls.feed(text));
    });

    // Install lifecycle and pipe error listeners before stdin.end or cancellation can fire.
    const onProcessError = (error: Error): void => {
      processError ??= error;
      if (!killReason) stopChild(signal?.aborted ? "aborted" : "io_error");
    };
    const closePromise = new Promise<number>((resolve) => {
      child.on("error", onProcessError);
      child.on("close", (code) => {
        closed = true;
        clearWatchdogs();
        if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
        resolve(code ?? -1);
      });
    });
    child.stdin?.on?.("error", onProcessError);
    child.stdout?.on("error", onProcessError);
    child.stderr?.on("error", onProcessError);
    overallTimer = setTimeout(() => stopChild("timeout"), timeoutMs);
    stallTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > stallTimeoutMs) stopChild("stall");
    }, Math.min(1_000, stallTimeoutMs));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (!killReason) {
      try { child.stdin?.end(invocation.stdin, "utf8"); }
      catch (error) { onProcessError(error instanceof Error ? error : new Error(String(error))); }
    }
    const exitCode = await closePromise;
    await treeCleanup;
    const stdoutTail = execStream.end();
    stdoutBuffer.append(stdoutTail);
    const stderrTail = stderrDecoder.end();
    stderrBuffer.append(stderrTail);
    for (const [source, text] of [["stdout", stdoutTail], ["stderr", stderrTail]] as const) {
      if (text) onEvent({ type: "raw", invocationId: request.invocationId, taskRunId: request.taskRunId, source, text });
    }
    emitNormalizedEvents(stderrToolCalls.feed(stderrTail));
    emitNormalizedEvents(stderrToolCalls.flush());
    const stdout = stdoutBuffer.value();
    const stderr = stderrBuffer.value();

    const cleanupWarning = cleanupFailed ? "; process tree cleanup was not confirmed" : "";
    if (killReason === "timeout") {
      throw new AgentCliError(
        AGENT_TIMEOUT,
        "timeout",
        `CLI exceeded ${timeoutMs}ms total timeout${cleanupWarning}`,
      );
    }
    if (killReason === "stall") {
      throw new AgentCliError(
        AGENT_STALL,
        "stall",
        `CLI produced no output for ${stallTimeoutMs}ms${cleanupWarning}`,
      );
    }
    if (killReason === "aborted") {
      throw new AgentCliError(
        AGENT_CANCELLED,
        "aborted",
        `Invocation cancelled by user${cleanupWarning}`,
      );
    }

    if (processError) {
      throw new AgentCliError(AGENT_SPAWN_FAILED, "spawn_failed", `${processError.message}${cleanupWarning}`);
    }

    if (exitCode !== 0) {
      throw new AgentCliError(
        AGENT_PROVIDER_UNAVAILABLE,
        "fatal",
        formatProviderExitFailure(provider, exitCode, stdout, stderr),
      );
    }

    const latencyMs = Date.now() - startedAt;
    const final = execStream.result();
    const tokenUsage = final.tokenUsage;
    const finalText = request.outputContract
      ? normalizeStructuredAgentOutput(final.text, request.outputContract)
      : final.text;
    onEvent({
      type: "assistant_text",
      invocationId: request.invocationId,
      taskRunId: request.taskRunId,
      text: finalText,
    });
    onEvent({
      type: "result",
      invocationId: request.invocationId,
      taskRunId: request.taskRunId,
      latencyMs,
    });

    return {
      provider,
      model,
      exitCode,
      stdout: finalText,
      rawStdout: stdout,
      stderr,
      normalizedEvents: normalizedEvents.toArray(),
      tokenUsage: tokenUsage ?? null,
      ...(
        stdoutBuffer.droppedBytes > 0 ||
        stderrBuffer.droppedBytes > 0 ||
        normalizedEvents.droppedEvents > 0
          ? {
              truncation: {
                stdoutDroppedBytes: stdoutBuffer.droppedBytes,
                stderrDroppedBytes: stderrBuffer.droppedBytes,
                normalizedEventsDropped: normalizedEvents.droppedEvents,
              },
            }
          : {}
      ),
      latencyMs,
    };
  }
}

export const buildProviderSpawnEnv = (
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const env = { ...parentEnv };
  for (const name of TRANSIENT_PARENT_CODEX_ENV) delete env[name];
  return env;
};
