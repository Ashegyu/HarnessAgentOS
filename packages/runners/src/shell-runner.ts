import { spawn } from "node:child_process";
import {
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
} from "@harness/core";
import { classifyShellCommand } from "./runner-policy.ts";
import { decodeCommandOutput, resolveWindowsCommand, simpleNpmArgs } from "./windows-command.ts";

export interface ShellRunResult {
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

  constructor(deps: ShellRunnerDeps = {}) {
    this.spawn = deps.spawn ?? spawn;
    this.abortKillGraceMs =
      deps.abortKillGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS;
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
      let onAbort: () => void = () => {};

      const cleanup = (options?: { clearAbortFallback?: boolean }): void => {
        if (hardTimer) clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (options?.clearAbortFallback !== false && abortFallbackTimer) {
          clearTimeout(abortFallbackTimer);
        }
      };
      const terminateForAbort = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        abortFallbackTimer = setTimeout(() => {
          if (closed) return;
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, this.abortKillGraceMs);
      };
      const fail = (
        code: string,
        message: string,
        options?: { clearAbortFallback?: boolean },
      ): void => {
        if (settled) return;
        settled = true;
        cleanup(options);
        reject(new ShellRunnerError(code, message));
      };
      const failExecution = (message: string): void => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        fail("RUNNER_EXECUTION_FAILED", message);
      };
      onAbort = (): void => {
        terminateForAbort();
        fail(
          "RUNNER_CANCELLED",
          `Command cancelled: ${commandDisplay}`,
          { clearAbortFallback: false },
        );
      };
      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failExecution(
            `Command idle timed out after ${idleTimeoutMs}ms: ${commandDisplay}`,
          );
        }, idleTimeoutMs);
      };

      const onStdout = (b: Buffer): void => {
        armIdleTimer();
        stdoutBytes += b.length;
        if (stdoutBytes < STDOUT_LIMIT) stdoutChunks.push(b);
        else if (!killedByLimit) {
          killedByLimit = true;
          stdoutChunks.push(Buffer.from("\n[output truncated]\n", "utf8"));
        }
      };
      const onStderr = (b: Buffer): void => {
        armIdleTimer();
        stderrBytes += b.length;
        if (stderrBytes < STDOUT_LIMIT) stderrChunks.push(b);
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (settled) return;

      hardTimer = setTimeout(() => {
        failExecution(`Command timed out after ${timeoutMs}ms: ${commandDisplay}`);
      }, timeoutMs);
      armIdleTimer();

      child.on("error", (err) => {
        if (settled) return;
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
    });
  }
}

const formatCommand = (command: string, args?: readonly string[]): string =>
  args === undefined || args.length === 0
    ? command
    : [command, ...args].join(" ");
