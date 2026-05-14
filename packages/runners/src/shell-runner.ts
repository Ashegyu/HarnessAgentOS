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
  async run(input: {
    command: string;
    cwd: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<ShellRunResult> {
    const safety = classifyShellCommand(input.command);
    if (safety.dangerous) {
      throw new ShellRunnerError(
        "RUNNER_BLOCKED_HIGH_RISK",
        `Command refused (${safety.reason ?? "high risk"}): ${input.command}`,
      );
    }

    const start = Date.now();
    return new Promise<ShellRunResult>((resolveResult, reject) => {
      const child = spawn(input.command, {
        shell: true,
        cwd: input.cwd,
        env: { ...process.env, ...(input.env ?? {}) },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let killedByLimit = false;
      let settled = false;
      const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_SHELL_TIMEOUT_MS;
      const idleTimeoutMs =
        input.idleTimeoutMs ?? DEFAULT_RUNNER_IDLE_TIMEOUT_MS;
      let hardTimer: NodeJS.Timeout;
      let idleTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        clearTimeout(hardTimer);
        if (idleTimer) clearTimeout(idleTimer);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new ShellRunnerError("RUNNER_EXECUTION_FAILED", message));
      };
      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          fail(
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

      hardTimer = setTimeout(() => {
        fail(`Command timed out after ${timeoutMs}ms: ${input.command}`);
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
