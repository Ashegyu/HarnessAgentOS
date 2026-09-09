import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { validateProposedActionDetails, type ProposedActionDetails } from "@harness/core";
import { isRealPathWithin } from "./runner-policy.ts";

type DeleteSnapshot = NonNullable<ProposedActionDetails["fileDelete"]>;

export const inspectDeleteFile = async (targetDir: string, path: string): Promise<DeleteSnapshot> => {
  const validation = validateProposedActionDetails({ type: "file_delete", fileDelete: { path } }, "file_delete");
  if (!validation.ok) throw new Error(`RUNNER_DELETE_PATH_INVALID: ${validation.reason}`);
  const absolute = resolve(targetDir, path);
  if (!(await isRealPathWithin(targetDir, absolute))) throw new Error("RUNNER_DELETE_PATH_OUTSIDE");
  // Reject every symlink/junction component, including links to an in-workspace file.
  let probe = resolve(targetDir);
  if ((await lstat(probe)).isSymbolicLink()) throw new Error("RUNNER_DELETE_LINK_BLOCKED");
  for (const segment of path.split(/[\\/]/)) {
    probe = join(probe, segment);
    if ((await lstat(probe)).isSymbolicLink()) throw new Error("RUNNER_DELETE_LINK_BLOCKED");
  }
  const canonical = await realpath(absolute);
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error("RUNNER_DELETE_REGULAR_FILE_REQUIRED");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await lstat(absolute);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== current.ino || current.isSymbolicLink() || canonical !== await realpath(absolute)) {
      throw new Error("RUNNER_DELETE_FILE_CHANGED");
    }
    return { path, sha256: hash.digest("hex"), sizeBytes: before.size, modifiedAt: before.mtime.toISOString() };
  } finally { await handle.close(); }
};

export class FileDeleteRunner {
  constructor(private readonly trashItem: (absolutePath: string) => Promise<void>) {}

  async run(targetDir: string, approved: DeleteSnapshot): Promise<{ path: string }> {
    const current = await inspectDeleteFile(targetDir, approved.path);
    if (!approved.sha256 || current.sha256 !== approved.sha256 || current.sizeBytes !== approved.sizeBytes || current.modifiedAt !== approved.modifiedAt) {
      throw new Error("RUNNER_DELETE_FILE_CHANGED: 파일 정보를 다시 확인하고 새 승인으로 진행하세요.");
    }
    const absolute = resolve(targetDir, current.path);
    // The host trash operation has no atomic compare-and-delete API. Revalidate immediately
    // before it; never fall back to unlink/rm if the OS refuses to recycle the file.
    if (!(await isRealPathWithin(targetDir, absolute))) throw new Error("RUNNER_DELETE_PATH_OUTSIDE");
    await this.trashItem(absolute);
    return { path: absolute };
  }
}
