import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type WorkspaceChangeKind = "added" | "modified" | "deleted";

export interface WorkspaceFileSnapshot {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  textContent?: string;
}

export interface WorkspaceSnapshot {
  targetDir: string;
  files: ReadonlyMap<string, WorkspaceFileSnapshot>;
  fileListTruncated: boolean;
}

export interface WorkspaceChange {
  kind: WorkspaceChangeKind;
  relativePath: string;
  before?: WorkspaceFileSnapshot;
  after?: WorkspaceFileSnapshot;
}

export interface WorkspaceChangeEvidence {
  changes: WorkspaceChange[];
  summary: string;
}

export interface WorkspaceSnapshotOptions {
  maxFiles?: number;
  maxFileContentBytes?: number;
  maxTotalContentBytes?: number;
  maxHashBytes?: number;
}

export interface WorkspaceChangeTracker {
  capture(targetDir: string): Promise<WorkspaceSnapshot>;
  buildEvidence(
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
  ): WorkspaceChangeEvidence;
}

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_FILE_CONTENT_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_CONTENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_HASH_BYTES = 1024 * 1024;
const MAX_EVIDENCE_CHARS = 200_000;

const IGNORED_DIRS = new Set([
  ".cache",
  ".codegraph",
  ".git",
  ".understand-anything",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export const captureWorkspaceSnapshot = async (
  targetDirInput: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> => {
  const targetDir = resolve(targetDirInput);
  const rootStat = await stat(targetDir);
  if (!rootStat.isDirectory()) {
    throw new Error(`workspace target is not a directory: ${targetDir}`);
  }

  const maxFiles = clamp(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 50_000);
  const maxFileContentBytes = clamp(
    options.maxFileContentBytes ?? DEFAULT_MAX_FILE_CONTENT_BYTES,
    0,
    4 * 1024 * 1024,
  );
  const maxTotalContentBytes = clamp(
    options.maxTotalContentBytes ?? DEFAULT_MAX_TOTAL_CONTENT_BYTES,
    0,
    64 * 1024 * 1024,
  );
  const maxHashBytes = clamp(
    options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES,
    0,
    16 * 1024 * 1024,
  );
  const files = new Map<string, WorkspaceFileSnapshot>();
  let capturedContentBytes = 0;
  let fileListTruncated = false;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        fileListTruncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(absolutePath);
        if (fileListTruncated) return;
        continue;
      }
      if (!entry.isFile()) continue;

      const fileStat = await lstat(absolutePath).catch(() => null);
      if (!fileStat?.isFile()) continue;
      const relativePath = toPosix(relative(targetDir, absolutePath));
      let bytes: Buffer | undefined;
      if (fileStat.size <= Math.max(maxHashBytes, maxFileContentBytes)) {
        bytes = await readFile(absolutePath).catch(() => undefined);
      }
      const contentHash = bytes && fileStat.size <= maxHashBytes
        ? sha256(bytes)
        : sha256(
            `${relativePath}\0${fileStat.size}\0${Math.trunc(fileStat.mtimeMs)}`,
          );
      const canCaptureText =
        bytes !== undefined &&
        fileStat.size <= maxFileContentBytes &&
        capturedContentBytes + bytes.length <= maxTotalContentBytes &&
        !bytes.includes(0);
      const textContent = canCaptureText && bytes
        ? bytes.toString("utf8")
        : undefined;
      const snapshot: WorkspaceFileSnapshot = {
        relativePath,
        sizeBytes: fileStat.size,
        mtimeMs: Math.trunc(fileStat.mtimeMs),
        contentHash,
        ...(textContent !== undefined ? { textContent } : {}),
      };
      if (textContent !== undefined) {
        capturedContentBytes += Buffer.byteLength(textContent, "utf8");
      }
      files.set(relativePath, snapshot);
    }
  };

  await visit(targetDir);
  return { targetDir, files, fileListTruncated };
};

export const buildWorkspaceChangeEvidence = (
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceChangeEvidence => {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changes: WorkspaceChange[] = [];
  for (const relativePath of [...paths].sort((a, b) => a.localeCompare(b))) {
    const previous = before.files.get(relativePath);
    const current = after.files.get(relativePath);
    if (!previous && current) {
      changes.push({ kind: "added", relativePath, after: current });
    } else if (previous && !current) {
      changes.push({ kind: "deleted", relativePath, before: previous });
    } else if (
      previous &&
      current &&
      previous.contentHash !== current.contentHash
    ) {
      changes.push({
        kind: "modified",
        relativePath,
        before: previous,
        after: current,
      });
    }
  }

  const lines = [
    "# Workspace change evidence",
    "",
    `Target: ${after.targetDir}`,
    `Changed files: ${changes.length}`,
    `Snapshot file list truncated: ${before.fileListTruncated || after.fileListTruncated ? "yes" : "no"}`,
    "",
    "## Changed-file manifest",
    "",
  ];
  if (changes.length === 0) {
    lines.push("No file changes observed.");
  } else {
    for (const change of changes) {
      const code = change.kind === "added" ? "A" : change.kind === "deleted" ? "D" : "M";
      const sizeBefore = change.before?.sizeBytes ?? 0;
      const sizeAfter = change.after?.sizeBytes ?? 0;
      lines.push(`- ${code} ${change.relativePath} (${sizeBefore} -> ${sizeAfter} bytes)`);
    }
  }

  lines.push("", "## Text diffs", "");
  for (const change of changes) {
    const beforeText = change.before?.textContent;
    const afterText = change.after?.textContent;
    if (
      (change.before && beforeText === undefined) ||
      (change.after && afterText === undefined)
    ) {
      lines.push(
        `### ${change.relativePath}`,
        "",
        "Text content omitted because the file is binary or exceeds the capture budget.",
        "",
      );
      continue;
    }
    lines.push(...formatWholeFileDiff(change.relativePath, beforeText ?? "", afterText ?? ""));
  }

  let summary = lines.join("\n");
  if (summary.length > MAX_EVIDENCE_CHARS) {
    summary = `${summary.slice(0, MAX_EVIDENCE_CHARS)}\n\n[workspace evidence truncated]`;
  }
  return { changes, summary };
};

export const defaultWorkspaceChangeTracker: WorkspaceChangeTracker = {
  capture: captureWorkspaceSnapshot,
  buildEvidence: buildWorkspaceChangeEvidence,
};

const formatWholeFileDiff = (
  relativePath: string,
  before: string,
  after: string,
): string[] => [
  `### ${relativePath}`,
  "",
  "```diff",
  `--- a/${relativePath}`,
  `+++ b/${relativePath}`,
  "@@ workspace snapshot @@",
  ...prefixLines(before, "-"),
  ...prefixLines(after, "+"),
  "```",
  "",
];

const prefixLines = (text: string, prefix: string): string[] => {
  if (text.length === 0) return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split(/\r?\n/).map((line) => `${prefix}${line}`);
};

const toPosix = (value: string): string =>
  sep === "/" ? value : value.split(sep).join("/");

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(Math.trunc(value), max));
