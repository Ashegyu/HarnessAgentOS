import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import {
  type RegressionControlEvidence,
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
} from "@harness/core";
import { classifyShellCommand } from "./runner-policy.ts";
import { decodeCommandOutput, resolveWindowsCommand, simpleNpmArgs } from "./windows-command.ts";

export interface ShellRunResult {
  regressionControl?: RegressionControlEvidence;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  cwd: string;
  durationMs: number;
}

export class ShellRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShellRunnerError";
    this.code = code;
  }
}

const STDOUT_LIMIT = 1_000_000; // 1 MB
const DEFAULT_ABORT_KILL_GRACE_MS = 2_000;

export interface ShellRunnerDeps {
  spawn?: typeof spawn;
  abortKillGraceMs?: number;
  terminationTimeoutMs?: number;
  terminateProcessTree?: (pid: number) => Promise<void>;
}

/**
 * Phase 3 shell runner. Executes a single approved command in the
 * target directory with hard timeout, idle timeout, and output cap.
 * Refuses dangerous patterns identified by RunnerPolicy.classifyShellCommand.
 *
 * Free-form command strings use `shell: true` so approved pipes and
 * redirection continue to work. Structured `command` + `args` payloads
 * bypass the shell and preserve each argument exactly. cwd is NOT a sandbox:
 * a host command can access other paths and requires individual manual consent.
 */
export class ShellRunner {
  private readonly spawn: typeof spawn;
  private readonly abortKillGraceMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly terminateProcessTree: ((pid: number) => Promise<void>) | undefined;

  constructor(deps: ShellRunnerDeps = {}) {
    this.spawn = deps.spawn ?? spawn;
    this.abortKillGraceMs =
      deps.abortKillGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS;
    this.terminationTimeoutMs = deps.terminationTimeoutMs ?? 12_000;
    this.terminateProcessTree = deps.terminateProcessTree ??
      (process.platform === "win32" ? terminateOwnedWindowsTree : undefined);
  }

  async run(input: {
    command: string;
    args?: string[];
    cwd: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<ShellRunResult> {
    if (input.signal?.aborted) {
      throw new ShellRunnerError(
        "RUNNER_CANCELLED",
        `Command cancelled before spawn: ${input.command}`,
      );
    }

    const commandDisplay = formatCommand(input.command, input.args);
    const safety = classifyShellCommand(commandDisplay);
    if (safety.dangerous) {
      throw new ShellRunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Command refused (${safety.reason ?? "high risk"}): ${commandDisplay}`,
      );
    }

    const start = Date.now();
    return new Promise<ShellRunResult>((resolveResult, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        const env = { ...process.env, ...(input.env ?? {}) };
        const simple = process.platform === "win32" && input.args === undefined ? simpleNpmArgs(input.command) : null;
        const structured = input.args !== undefined || simple !== null;
        const resolved = process.platform === "win32" && structured
          ? resolveWindowsCommand(simple?.command ?? input.command, simple?.args ?? input.args ?? [], env)
          : { command: input.command, args: input.args };
        if ("nodeDir" in resolved && resolved.nodeDir) {
          const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
          env[key] = `${resolved.nodeDir};${env[key] ?? ""}`;
        }
        const commonOptions = {
          cwd: input.cwd,
          env,
          windowsHide: true,
        };
        child = !structured
          ? this.spawn(input.command, { ...commonOptions, shell: true })
          : this.spawn(resolved.command, resolved.args ?? [], {
              ...commonOptions,
              shell: false,
            });
      } catch (e) {
        reject(
          new ShellRunnerError(
            "RUNNER_EXECUTION_FAILED",
            `Failed to spawn: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let killedByLimit = false;
      let settled = false;
      const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_SHELL_TIMEOUT_MS;
      const idleTimeoutMs =
        input.idleTimeoutMs ?? DEFAULT_RUNNER_IDLE_TIMEOUT_MS;
      let hardTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;
      let abortFallbackTimer: NodeJS.Timeout | undefined;
      let closed = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      let stopping: { code: string; message: string } | undefined;
      let treePending = false;
      let cleanupFailed = false;
      let onAbort: () => void = () => {};

      const cleanup = (): void => {
        if (hardTimer) clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
      };
      const fail = (
        code: string,
        message: string,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ShellRunnerError(code, message));
      };
      const finishStop = (): void => {
        if (!stopping || !closed || treePending) return;
        fail(cleanupFailed ? "RUNNER_TERMINATION_UNCONFIRMED" : stopping.code,
          cleanupFailed ? `Process tree termination could not be confirmed: ${commandDisplay}` : stopping.message);
      };
      const killRoot = (signal: NodeJS.Signals): void => {
        if (closed || settled) return;
        try { child.kill(signal); } catch { cleanupFailed = true; }
      };
      const stop = (code: string, message: string): void => {
        if (settled || stopping) return;
        stopping = { code, message };
        cleanup();
        terminationTimer = setTimeout(() => {
          killRoot("SIGKILL");
          fail("RUNNER_TERMINATION_UNCONFIRMED", `Process termination could not be confirmed: ${commandDisplay}`);
        }, this.terminationTimeoutMs);
        if (this.terminateProcessTree && child.pid !== undefined) {
          treePending = true;
          // Keep the root alive while taskkill discovers its descendants.
          void Promise.resolve().then(() => this.terminateProcessTree!(child.pid!))
            .catch(() => { cleanupFailed = true; killRoot("SIGKILL"); })
            .finally(() => { treePending = false; finishStop(); });
        } else {
          killRoot("SIGTERM");
          if (!closed) abortFallbackTimer = setTimeout(() => killRoot("SIGKILL"), this.abortKillGraceMs);
        }
      };
      const failExecution = (message: string): void => stop("RUNNER_EXECUTION_FAILED", message);
      onAbort = (): void => stop("RUNNER_CANCELLED", `Command cancelled: ${commandDisplay}`);
      const armIdleTimer = (): void => {
        if (settled || stopping) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failExecution(
            `Command idle timed out after ${idleTimeoutMs}ms: ${commandDisplay}`,
          );
        }, idleTimeoutMs);
      };

      const onStdout = (b: Buffer): void => {
        if (settled || stopping) return;
        armIdleTimer();
        stdoutBytes += b.length;
        if (stdoutBytes < STDOUT_LIMIT) stdoutChunks.push(b);
        else if (!killedByLimit) {
          killedByLimit = true;
          stdoutChunks.push(Buffer.from("\n[output truncated]\n", "utf8"));
        }
      };
      const onStderr = (b: Buffer): void => {
        if (settled || stopping) return;
        armIdleTimer();
        stderrBytes += b.length;
        if (stderrBytes < STDOUT_LIMIT) stderrChunks.push(b);
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      child.on("error", (err) => {
        if (settled) return;
        if (stopping) { cleanupFailed = true; return; }
        settled = true;
        cleanup();
        reject(
          new ShellRunnerError(
            "RUNNER_EXECUTION_FAILED",
            `Failed to spawn: ${(err as Error).message}`,
          ),
        );
      });

      child.on("close", (code) => {
        closed = true;
        if (abortFallbackTimer) clearTimeout(abortFallbackTimer);
        if (settled) return;
        if (stopping) { finishStop(); return; }
        settled = true;
        cleanup();
        resolveResult({
          exitCode: typeof code === "number" ? code : -1,
          stdout: decodeCommandOutput(Buffer.concat(stdoutChunks)),
          stderr: decodeCommandOutput(Buffer.concat(stderrChunks)),
          command: commandDisplay,
          cwd: input.cwd,
          durationMs: Date.now() - start,
        });
      });

      // Register lifecycle listeners before an already-aborted signal can kill.
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
      if (settled || stopping) return;
      hardTimer = setTimeout(() => {
        failExecution(`Command timed out after ${timeoutMs}ms: ${commandDisplay}`);
      }, timeoutMs);
      armIdleTimer();
    });
  }
}

const terminateOwnedWindowsTree = (pid: number): Promise<void> => new Promise((resolve, reject) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    reject(new Error("Invalid owned process PID"));
    return;
  }
  execFile(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
    error => error ? reject(new Error("Process tree cleanup could not be confirmed")) : resolve());
});

const formatCommand = (command: string, args?: readonly string[]): string =>
  args === undefined || args.length === 0
    ? command
    : [command, ...args].join(" ");
