import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import type { RepoIndexFile, RepoIndexFileKind } from "@harness/core";

export interface RepoIndexStore {
  upsertMany(files: RepoIndexFile[]): Promise<void>;
  listByTarget(input: {
    projectKey: string;
    targetDir: string;
    limit?: number;
  }): Promise<RepoIndexFile[]>;
  deleteMissing(input: {
    projectKey: string;
    targetDir: string;
    keepRelativePaths: string[];
  }): Promise<void>;
}

export interface RepoIndexRefreshInput {
  projectKey: string;
  targetDir: string;
  maxFiles?: number;
  maxReadBytes?: number;
}

export interface RepoIndexServiceDeps {
  store: RepoIndexStore;
  now?: () => string;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_READ_BYTES = 96 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".ps1",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export class RepoIndexService {
  private readonly deps: RepoIndexServiceDeps;

  constructor(deps: RepoIndexServiceDeps) {
    this.deps = deps;
  }

  async refresh(input: RepoIndexRefreshInput): Promise<RepoIndexFile[]> {
    const targetDir = resolve(input.targetDir);
    const rootStat = await stat(targetDir);
    if (!rootStat.isDirectory()) {
      throw new Error(`targetDir is not a directory: ${targetDir}`);
    }
    const maxFiles = Math.max(1, Math.min(input.maxFiles ?? DEFAULT_MAX_FILES, 5_000));
    const maxReadBytes = Math.max(4 * 1024, input.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
    const relativePaths = await this.collectFiles(targetDir, maxFiles);
    const updatedAt = this.deps.now?.() ?? new Date().toISOString();
    const files: RepoIndexFile[] = [];
    for (const relativePath of relativePaths) {
      const absolutePath = resolve(targetDir, relativePath);
      const s = await lstat(absolutePath);
      if (!s.isFile()) continue;
      const content =
        isTextPath(relativePath) && s.size <= maxReadBytes
          ? await readFile(absolutePath, "utf8").catch(() => "")
          : "";
      const hash = content.length > 0
        ? sha256(content)
        : sha256(`${relativePath}:${s.size}:${Math.trunc(s.mtimeMs)}`);
      files.push({
        id: repoIndexId(input.projectKey, targetDir, relativePath),
        projectKey: input.projectKey,
        targetDir,
        relativePath,
        fileKind: classifyPath(relativePath),
        sizeBytes: s.size,
        mtimeMs: Math.trunc(s.mtimeMs),
        contentHash: hash,
        summary: summarizeFile(relativePath, content, s.size),
        symbols: extractSymbols(content),
        imports: extractImports(content),
        updatedAt,
      });
    }
    await this.deps.store.upsertMany(files);
    await this.deps.store.deleteMissing({
      projectKey: input.projectKey,
      targetDir,
      keepRelativePaths: files.map((file) => file.relativePath),
    });
    return this.deps.store.listByTarget({
      projectKey: input.projectKey,
      targetDir,
      limit: maxFiles,
    });
  }

  private async collectFiles(root: string, maxFiles: number): Promise<string[]> {
    const result: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (result.length >= maxFiles) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (result.length >= maxFiles) return;
        if (entry.name.startsWith(".") && entry.name !== ".github") {
          if (entry.isDirectory()) continue;
        }
        const absolutePath = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = toPosix(relative(root, absolutePath));
        if (!shouldIndexPath(relativePath)) continue;
        result.push(relativePath);
      }
    };
    await visit(root);
    return result;
  }
}

export const repoIndexId = (
  projectKey: string,
  targetDir: string,
  relativePath: string,
): string => `repoidx_${sha256(`${projectKey}\0${targetDir}\0${relativePath}`).slice(0, 32)}`;

export const classifyPath = (relativePath: string): RepoIndexFileKind => {
  const name = basename(relativePath).toLowerCase();
  const ext = extname(relativePath).toLowerCase();
  if (name === "package.json") return "package";
  if (
    name.includes("config") ||
    name.startsWith("tsconfig") ||
    name.startsWith("vite.config") ||
    name.startsWith("electron.") ||
    ext === ".toml" ||
    ext === ".yml" ||
    ext === ".yaml"
  ) {
    return "config";
  }
  if (name.endsWith(".test.ts") || name.endsWith(".test.mjs") || name.endsWith(".spec.ts")) {
    return "test";
  }
  if (ext === ".md" || ext === ".mdx") return "doc";
  if (ext === ".css") return "style";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "source";
  return "other";
};

export const summarizeFile = (
  relativePath: string,
  content: string,
  sizeBytes: number,
): string => {
  if (content.trim().length === 0) {
    return `Indexed metadata only (${sizeBytes} bytes).`;
  }
  const name = basename(relativePath).toLowerCase();
  if (name === "package.json") {
    try {
      const pkg = JSON.parse(content) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 8);
      const deps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ].slice(0, 10);
      return [
        pkg.name ? `package ${pkg.name}` : "package.json",
        scripts.length > 0 ? `scripts: ${scripts.join(", ")}` : "",
        deps.length > 0 ? `deps: ${deps.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    } catch {
      return "package.json (invalid JSON)";
    }
  }
  if (relativePath.toLowerCase().endsWith(".md")) {
    const headings = content
      .split(/\r?\n/)
      .filter((line) => /^#{1,3}\s+\S/.test(line))
      .map((line) => line.replace(/^#{1,3}\s+/, "").trim())
      .slice(0, 8);
    if (headings.length > 0) return `headings: ${headings.join(" | ")}`;
  }
  const symbols = extractSymbols(content).slice(0, 8);
  if (symbols.length > 0) return `symbols: ${symbols.join(", ")}`;
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 400);
};

export const extractSymbols = (content: string): string[] => {
  if (content.length === 0) return [];
  const symbols = new Set<string>();
  const patterns = [
    /\bexport\s+(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s*\{\s*([^}]+)\s*\}/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null && symbols.size < 24) {
      const raw = match[1] ?? "";
      for (const part of raw.split(",")) {
        const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.add(name);
        if (symbols.size >= 24) break;
      }
    }
  }
  return [...symbols];
};

export const extractImports = (content: string): string[] => {
  if (content.length === 0) return [];
  const imports = new Map<string, number>();
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null && imports.size < 24) {
      const value = match[1];
      if (value && !imports.has(value)) imports.set(value, match.index);
    }
  }
  return [...imports.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([value]) => value);
};

const shouldIndexPath = (relativePath: string): boolean => {
  const ext = extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || basename(relativePath).toLowerCase() === "package.json";
};

const isTextPath = (relativePath: string): boolean => shouldIndexPath(relativePath);

const toPosix = (path: string): string => path.split(sep).join("/");

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
