import { mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { BigIntStats } from "node:fs";
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

// All FileRunner instances in this main process share file ownership. A path
// alias and a not-yet-created file use the same canonical destination key.
const fileWrites = new Map<string, Promise<void>>();
const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

const canonicalDestination = async (path: string): Promise<string> => {
  let probe = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = resolve(await realpath(probe), ...suffix);
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
};

const changed = (path: string): FileRunnerError => new FileRunnerError(
  "RUNNER_FILE_CONTENT_CHANGED", `Refusing to overwrite a file changed after approval: ${path}`,
);
const requireSingleLinkFile = (info: BigIntStats, path: string): void => {
  if (!info.isFile() || info.nlink !== 1n) {
    throw new FileRunnerError("RUNNER_FILE_REGULAR_SINGLE_LINK_REQUIRED", `Refusing to write a non-regular or multiply-linked file: ${path}`);
  }
};
const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new FileRunnerError("RUNNER_CANCELLED", "File execution cancelled before writing");
};
const waitForFileTurn = async (previous: Promise<void>, signal?: AbortSignal): Promise<void> => {
  throwIfCancelled(signal);
  if (!signal) return previous;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new FileRunnerError("RUNNER_CANCELLED", "File execution cancelled while waiting for file ownership"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([previous, interrupted]);
    throwIfCancelled(signal);
  } finally { signal.removeEventListener("abort", abort); }
};

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
    signal?: AbortSignal;
  }): Promise<FileRunResult> {
    throwIfCancelled(input.signal);
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

    const key = await canonicalDestination(targetAbs);
    throwIfCancelled(input.signal);
    const previous = fileWrites.get(key) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    // A cancelled waiter can settle promptly, but its successors still wait
    // for the earlier owner. Deleting an aborted middle token would let them
    // enter the file while that owner is still active.
    const current = previous.then(() => released);
    fileWrites.set(key, current);
    void current.then(() => { if (fileWrites.get(key) === current) fileWrites.delete(key); });
    try {
      await waitForFileTurn(previous, input.signal);
      throwIfCancelled(input.signal);
      if (await canonicalDestination(targetAbs) !== key) throw changed(targetAbs);
      if (!(await isRealPathWithin(input.targetDir, targetAbs))) {
        throw new FileRunnerError("RUNNER_TARGET_OUTSIDE_WORKSPACE", `Refusing to write outside targetDir: ${targetAbs}`);
      }
      let exists = true;
      try { requireSingleLinkFile(await stat(targetAbs, { bigint: true }), targetAbs); }
      catch (error) { if (!isMissing(error)) throw error; exists = false; }
      if (!exists && input.patch.before !== undefined && input.patch.before !== null) throw changed(targetAbs);

      throwIfCancelled(input.signal);
      await mkdir(dirname(targetAbs), { recursive: true });
      if (!(await isRealPathWithin(input.targetDir, targetAbs))) {
        throw new FileRunnerError("RUNNER_TARGET_OUTSIDE_WORKSPACE", `Refusing to write outside targetDir: ${targetAbs}`);
      }
      if (await canonicalDestination(targetAbs) !== key) throw changed(targetAbs);
      throwIfCancelled(input.signal);
      let handle;
      try { handle = await open(targetAbs, exists ? "r+" : "wx"); }
      catch (error) {
        if (isMissing(error) || (error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw changed(targetAbs);
        throw error;
      }
      try {
        const opened = await handle.stat({ bigint: true });
        requireSingleLinkFile(opened, targetAbs);
        const beforeContent = exists ? await handle.readFile("utf8") : null;
        if (input.patch.before !== undefined && input.patch.before !== beforeContent) throw changed(targetAbs);

        const bound = await handle.stat({ bigint: true });
        const pathInfo = await stat(targetAbs, { bigint: true });
        requireSingleLinkFile(bound, targetAbs);
        requireSingleLinkFile(pathInfo, targetAbs);
        if (opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino ||
            opened.size !== bound.size || opened.mtimeNs !== bound.mtimeNs ||
            await canonicalDestination(targetAbs) !== key || !(await isRealPathWithin(input.targetDir, targetAbs))) {
          throw changed(targetAbs);
        }
        // Keep the validated handle bound to the same inode. Explicit positions
        // avoid readFile's cursor and preserve empty/short replacement behavior.
        throwIfCancelled(input.signal);
        const bytes = Buffer.from(input.patch.after, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
          if (bytesWritten === 0) throw new FileRunnerError("RUNNER_EXECUTION_FAILED", "File write made no progress");
          offset += bytesWritten;
        }
        await handle.truncate(bytes.length);
        return { path: targetAbs, beforeContent, afterContent: input.patch.after, bytesWritten: bytes.length };
      } finally { await handle.close(); }
    } finally {
      release();
    }
  }
}
