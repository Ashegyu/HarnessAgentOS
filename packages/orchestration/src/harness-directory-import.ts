import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  importHarnessPackageFromFiles,
  type HarnessSourceFileInput,
  type ImportHarnessPackageInput,
  type ImportHarnessPackageResult,
} from "./harness-import.ts";

export interface ReadHarnessSourceDirectoryOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  includeExtensions?: readonly string[];
  excludeDirNames?: readonly string[];
}

export interface ImportHarnessPackageFromDirectoryInput
  extends Omit<ImportHarnessPackageInput, "files">,
    ReadHarnessSourceDirectoryOptions {}

export interface ReadHarnessSourceDirectoryResult {
  rootDir: string;
  files: readonly HarnessSourceFileInput[];
  skipped: readonly ReadHarnessSourceDirectorySkippedFile[];
}

export interface ReadHarnessSourceDirectorySkippedFile {
  relativePath: string;
  reason: "extension" | "size" | "file_limit" | "depth" | "directory";
}

const DEFAULT_MAX_FILES = 750;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_INCLUDE_EXTENSIONS = [".md", ".json"] as const;
const DEFAULT_EXCLUDE_DIR_NAMES = [
  ".git",
  ".codegraph",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
] as const;

export const importHarnessPackageFromDirectory = async (
  input: ImportHarnessPackageFromDirectoryInput,
): Promise<ImportHarnessPackageResult> => {
  const scan = await readHarnessSourceDirectory(input.rootDir, input);
  return importHarnessPackageFromFiles({
    ...input,
    files: scan.files,
  });
};

export const readHarnessSourceDirectory = async (
  rootDir: string,
  options: ReadHarnessSourceDirectoryOptions = {},
): Promise<ReadHarnessSourceDirectoryResult> => {
  const resolvedRoot = path.resolve(rootDir);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const includeExtensions = new Set(
    (options.includeExtensions ?? DEFAULT_INCLUDE_EXTENSIONS).map((ext) =>
      ext.toLowerCase(),
    ),
  );
  const excludeDirNames = new Set(
    (options.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES).map((name) =>
      name.toLowerCase(),
    ),
  );
  const files: HarnessSourceFileInput[] = [];
  const skipped: ReadHarnessSourceDirectorySkippedFile[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      skipped.push({
        relativePath: toRelativePath(resolvedRoot, dir),
        reason: "depth",
      });
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = toRelativePath(resolvedRoot, fullPath);
      if (entry.isDirectory()) {
        if (excludeDirNames.has(entry.name.toLowerCase())) {
          skipped.push({ relativePath, reason: "directory" });
          continue;
        }
        await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        skipped.push({ relativePath, reason: "file_limit" });
        continue;
      }
      if (!includeExtensions.has(path.extname(entry.name).toLowerCase())) {
        skipped.push({ relativePath, reason: "extension" });
        continue;
      }
      const fileStat = await stat(fullPath);
      if (fileStat.size > maxFileBytes) {
        skipped.push({ relativePath, reason: "size" });
        continue;
      }
      files.push({
        relativePath,
        content: await readFile(fullPath, "utf8"),
      });
    }
  };

  await visit(resolvedRoot, 0);
  return { rootDir: resolvedRoot, files, skipped };
};

const toRelativePath = (rootDir: string, fullPath: string): string => {
  const relative = path.relative(rootDir, fullPath);
  return relative.replaceAll("\\", "/");
};
