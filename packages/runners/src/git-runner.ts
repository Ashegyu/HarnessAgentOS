import { ShellRunner } from "./shell-runner";

export interface GitInspectionResult {
  status: string;
  diff: string;
  ok: boolean;
  warning?: string;
}

/**
 * Phase 3 git runner. MVP only does inspection: `git status` and
 * `git diff`. Commits/pushes/resets are blocked or require separate
 * high-risk approvals (see phase-03 보안/승인 정책).
 */
export class GitRunner {
  constructor(private readonly shell: ShellRunner = new ShellRunner()) {}

  async inspect(targetDir: string): Promise<GitInspectionResult> {
    try {
      const status = await this.shell.run({
        command: "git status --porcelain",
        cwd: targetDir,
        timeoutMs: 30_000,
      });
      if (status.exitCode !== 0) {
        return {
          status: status.stderr || status.stdout,
          diff: "",
          ok: false,
          warning: "git status failed (not a git repo?)",
        };
      }
      const diff = await this.shell.run({
        command: "git diff --no-color",
        cwd: targetDir,
        timeoutMs: 60_000,
      });
      return {
        status: status.stdout,
        diff: diff.stdout,
        ok: diff.exitCode === 0,
      };
    } catch (e) {
      return {
        status: "",
        diff: "",
        ok: false,
        warning: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
