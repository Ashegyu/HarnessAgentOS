import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isWithin } from "./runner-policy";
import type { ProposedFilePatch } from "./runner-types";

export interface FileRunResult {
  path: string;
  beforeContent: string | null; // null = file didn't exist before
  afterContent: string;
  bytesWritten: number;
}

export class FileRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FileRunnerError";
  }
}

/**
 * Phase 3 file runner. Writes the after-content to disk after asserting
 * targetDir containment. Captures before-content as the diff baseline.
 *
 * Refuses anything outside targetDir (security policy from
 * docs/architecture/security-and-approval-architecture.md).
 */
export class FileRunner {
  async run(input: {
    targetDir: string;
    patch: ProposedFilePatch;
  }): Promise<FileRunResult> {
    const targetAbs = isAbsolute(input.patch.path)
      ? input.patch.path
      : resolve(input.targetDir, input.patch.path);

    if (!isWithin(input.targetDir, targetAbs)) {
      throw new FileRunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `Refusing to write outside targetDir: ${targetAbs}`,
      );
    }

    let beforeContent: string | null = null;
    try {
      const s = await stat(targetAbs);
      if (s.isFile()) {
        beforeContent = await readFile(targetAbs, "utf8");
      }
    } catch {
      // Missing file is fine; we'll create it.
    }

    await mkdir(dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, input.patch.after, "utf8");

    return {
      path: targetAbs,
      beforeContent,
      afterContent: input.patch.after,
      bytesWritten: Buffer.byteLength(input.patch.after, "utf8"),
    };
  }
}
