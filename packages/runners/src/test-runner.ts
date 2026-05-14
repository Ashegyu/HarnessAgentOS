import { ShellRunner } from "./shell-runner.ts";
import type { ShellRunResult } from "./shell-runner.ts";

export interface TestRunResult extends ShellRunResult {
  passed: boolean;
}

/**
 * Phase 3 test runner. Runs an approved test command in targetDir.
 * MVP does not introspect framework output; pass/fail is just exit==0.
 */
export class TestRunner {
  private readonly shell: ShellRunner;
  constructor(shell: ShellRunner = new ShellRunner()) {
    this.shell = shell;
  }

  async run(input: {
    command: string;
    cwd: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
  }): Promise<TestRunResult> {
    const r = await this.shell.run(input);
    return { ...r, passed: r.exitCode === 0 };
  }
}
