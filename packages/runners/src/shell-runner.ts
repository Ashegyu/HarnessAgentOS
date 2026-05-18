import { spawn } from "node:child_process";
import {
  DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
  DEFAULT_RUNNER_SHELL_TIMEOUT_MS,
} from "@harness/core";
import { classifyShellCommand } from "./runner-policy.ts";

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
 * Uses `shell: true` because user-approved commands often include
 * pipes/redirection. Containment is enforced by setting cwd to the
 * approved targetDir; commands themselves can still escape via
 * absolute paths, which is why dangerous-token classification runs
 * first.
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

    const safety = classifyShellCommand(input.command);
    if (safety.dangerous) {
      throw new ShellRunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Command refused (${safety.reason ?? "high risk"}): ${input.command}`,
      );
    }

    const start = Date.now();
    return new Promise<ShellRunResult>((resolveResult, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.spawn(input.command, {
          shell: true,
          cwd: input.cwd,
          env: { ...process.env, ...(input.env ?? {}) },
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
          `Command cancelled: ${input.command}`,
          { clearAbortFallback: false },
        );
      };
      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          failExecution(
            `Command idle timed out after ${idleTimeoutMs}ms: ${input.command}`,
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
        failExecution(`Command timed out after ${timeoutMs}ms: ${input.command}`);
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
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          command: input.command,
          cwd: input.cwd,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}
