import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isRealPathWithin, isWithin } from "./runner-policy.ts";
import type { ProposedFilePatch } from "./runner-types.ts";

export interface FileRunResult {
  path: string;
  beforeContent: string | null; // null = file didn't exist before
  afterContent: string;
  bytesWritten: number;
}

export class FileRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FileRunnerError";
    this.code = code;
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

    if (
      !isWithin(input.targetDir, targetAbs) ||
      !(await isRealPathWithin(input.targetDir, targetAbs))
    ) {
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

    if (
      input.patch.before !== undefined &&
      input.patch.before !== beforeContent
    ) {
      throw new FileRunnerError(
        "RUNNER_FILE_CONTENT_CHANGED",
        `Refusing to overwrite a file changed after approval: ${targetAbs}`,
      );
    }

    await mkdir(dirname(targetAbs), { recursive: true });
    // 생성 직후 다시 canonical parent를 확인해 junction 교체 창을 줄인다.
    if (!(await isRealPathWithin(input.targetDir, targetAbs))) {
      throw new FileRunnerError(
        "RUNNER_TARGET_OUTSIDE_WORKSPACE",
        `Refusing to write outside targetDir: ${targetAbs}`,
      );
    }
    await writeFile(targetAbs, input.patch.after, "utf8");

    return {
      path: targetAbs,
      beforeContent,
      afterContent: input.patch.after,
      bytesWritten: Buffer.byteLength(input.patch.after, "utf8"),
    };
  }
}
