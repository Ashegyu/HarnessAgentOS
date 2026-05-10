import { spawn } from "node:child_process";
import { classifyShellCommand } from "./runner-policy";

export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  cwd: string;
  durationMs: number;
}

export class ShellRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ShellRunnerError";
  }
}

const STDOUT_LIMIT = 1_000_000; // 1 MB
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Phase 3 shell runner. Executes a single approved command in the
 * target directory with timeout + output cap. Refuses dangerous
 * patterns identified by RunnerPolicy.classifyShellCommand.
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

      const onStdout = (b: Buffer): void => {
        stdoutBytes += b.length;
        if (stdoutBytes < STDOUT_LIMIT) stdoutChunks.push(b);
        else if (!killedByLimit) {
          killedByLimit = true;
          stdoutChunks.push(Buffer.from("\n[output truncated]\n", "utf8"));
        }
      };
      const onStderr = (b: Buffer): void => {
        stderrBytes += b.length;
        if (stderrBytes < STDOUT_LIMIT) stderrChunks.push(b);
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(
          new ShellRunnerError(
            "RUNNER_EXECUTION_FAILED",
            `Command timed out after ${timeoutMs}ms: ${input.command}`,
          ),
        );
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new ShellRunnerError(
            "RUNNER_EXECUTION_FAILED",
            `Failed to spawn: ${(err as Error).message}`,
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
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
