import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface FsSnapshot {
  readonly root: string;
  readonly entries: ReadonlyMap<string, string>;
}

export interface FsDiff {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly modified: ReadonlyArray<string>;
}

export const snapshotTree = async (root: string): Promise<FsSnapshot> => {
  const resolvedRoot = path.resolve(root);
  const entries = new Map<string, string>();
  await walk(resolvedRoot, resolvedRoot, entries);
  return { root: resolvedRoot, entries };
};

export const diffSnapshots = (
  before: FsSnapshot,
  after: FsSnapshot,
): FsDiff => {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [rel, hash] of after.entries) {
    const previous = before.entries.get(rel);
    if (previous === undefined) {
      added.push(rel);
    } else if (previous !== hash) {
      modified.push(rel);
    }
  }

  for (const rel of before.entries.keys()) {
    if (!after.entries.has(rel)) {
      removed.push(rel);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
  };
};

export const allChangesInside = (
  diff: FsDiff,
  root: string,
  allowedRoot: string,
): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedAllowedRoot = path.resolve(allowedRoot);
  const changed = [...diff.added, ...diff.removed, ...diff.modified];
  return changed.every((rel) => {
    const abs = path.resolve(resolvedRoot, rel);
    return isInsideOrSame(resolvedAllowedRoot, abs);
  });
};

const walk = async (
  root: string,
  dir: string,
  out: Map<string, string>,
): Promise<void> => {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walk(root, abs, out);
    } else if (dirent.isFile()) {
      const rel = path.relative(root, abs);
      const content = await fs.readFile(abs);
      out.set(rel, createHash("sha256").update(content).digest("hex"));
    }
  }
};

const isInsideOrSame = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
