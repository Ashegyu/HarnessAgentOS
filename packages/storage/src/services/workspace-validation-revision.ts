import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ValidationRevision {
  workspaceKey: string;
  fingerprint: string | null;
  reason?: string;
}

export interface CaptureValidationRevisionOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Git tracked + nonignored untracked inputs; plain folders use this explicit policy. */
export const VALIDATION_INPUT_POLICY = {
  version: "validation-inputs-v1",
  recursiveExcludedDirectories: [".git", "node_modules", ".cache", ".next", ".nuxt", ".turbo", "bin", "obj"],
  rootExcludedDirectories: ["build", "dist", "out", "coverage", "test-results", "playwright-report"],
} as const;

const recursiveExclusions = new Set<string>(VALIDATION_INPUT_POLICY.recursiveExcludedDirectories);
const rootExclusions = new Set<string>(VALIDATION_INPUT_POLICY.rootExcludedDirectories);
const normalizeKey = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;
const isMissing = (error: unknown): boolean => error !== null && typeof error === "object" &&
  "code" in error && error.code === "ENOENT";
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** Cheap mutation identity. Missing roots retain a stable key but cannot be fingerprinted. */
export const resolveValidationWorkspaceKey = async (targetDir: string): Promise<string> => {
  const absolute = resolve(targetDir);
  const suffix: string[] = [];
  for (let probe = absolute;;) {
    try { return normalizeKey(resolve(await fs.realpath(probe), ...suffix)); }
    catch (error) {
      if (!isMissing(error)) return normalizeKey(absolute);
      const parent = dirname(probe);
      if (parent === probe) return normalizeKey(absolute);
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
};

class UnverifiableRevision extends Error {}
interface InputFile { path: string; absolute: string; metadata: string; size: number }
interface InputScope { kind: "git" | "plain"; gitRoot?: string }

/**
 * Full content identities, never advisory size/mtime fallbacks. Both the file
 * handle and the complete input inventory must stay stable while hashing.
 */
export const captureValidationRevision = async (
  targetDir: string,
  options: CaptureValidationRevisionOptions = {},
): Promise<ValidationRevision> => {
  if (options.signal?.aborted) return { workspaceKey: normalizeKey(resolve(targetDir)), fingerprint: null, reason: "capture_cancelled" };
  const workspaceKey = await resolveValidationWorkspaceKey(targetDir);
  const maxFiles = limit(options.maxFiles, 20_000);
  const maxFileBytes = limit(options.maxFileBytes, 64 * 1024 * 1024);
  const maxTotalBytes = limit(options.maxTotalBytes, 256 * 1024 * 1024);
  const timeoutMs = limit(options.timeoutMs, 30_000);
  const deadline = Date.now() + timeoutMs;
  const checkTime = (): void => {
    if (options.signal?.aborted) throw new UnverifiableRevision("capture_cancelled");
    if (Date.now() >= deadline) throw new UnverifiableRevision("capture_time_limit");
  };
  try {
    if (!isAbsolute(targetDir)) throw new UnverifiableRevision("workspace_not_absolute");
    checkTime();
    const root = await fs.realpath(targetDir);
    const rootInfo = await fs.stat(root, { bigint: true });
    if (!rootInfo.isDirectory()) throw new UnverifiableRevision("workspace_not_directory");
    checkTime();
    const scope = await discoverScope(root, Math.max(1, deadline - Date.now()), options.signal);

    const inventory = async (): Promise<InputFile[]> => {
      checkTime();
      let paths: string[];
      if (scope.kind === "git") {
        const output = await runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name", "--", "."], Math.max(1, deadline - Date.now()), options.signal);
        paths = output.split("\0").filter(Boolean).map(path => resolve(scope.gitRoot!, path));
      } else {
        paths = [];
        const visit = async (directory: string, depth: number): Promise<void> => {
          checkTime();
          const entries = await fs.readdir(directory, { withFileTypes: true });
          for (const entry of entries) {
            const absolute = resolve(directory, entry.name);
            if (entry.isDirectory()) {
              if (recursiveExclusions.has(entry.name) || (depth === 0 && rootExclusions.has(entry.name))) continue;
              await visit(absolute, depth + 1);
            } else {
              paths.push(absolute);
              if (paths.length > maxFiles) throw new UnverifiableRevision("file_count_limit");
            }
          }
        };
        await visit(root, 0);
      }
      paths = [...new Set(paths)];
      if (paths.length > maxFiles) throw new UnverifiableRevision("file_count_limit");
      paths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      let bytes = 0;
      const files: InputFile[] = [];
      for (const absolute of paths) {
        checkTime();
        if (!inside(root, absolute)) throw new UnverifiableRevision("input_outside_workspace");
        let info: BigIntStats;
        try { info = await fs.lstat(absolute, { bigint: true }); }
        catch (error) {
          if (!isMissing(error) || scope.kind !== "git") throw error;
          // Git still lists intentionally deleted tracked paths. Their absence
          // is an input state, provided it is stable and not a dangling alias.
          await requireUnambiguousMissingPath(root, absolute);
          files.push({ path: relative(root, absolute).split(sep).join("/"), absolute, metadata: "missing", size: 0 });
          continue;
        }
        if (info.isSymbolicLink() || !info.isFile()) throw new UnverifiableRevision("ambiguous_input_type");
        if (info.size > BigInt(maxFileBytes)) throw new UnverifiableRevision("file_byte_limit");
        bytes += Number(info.size);
        if (bytes > maxTotalBytes) throw new UnverifiableRevision("total_byte_limit");
        const canonical = await fs.realpath(absolute);
        if (!inside(root, canonical) || normalizeKey(canonical) !== normalizeKey(absolute)) {
          throw new UnverifiableRevision("ambiguous_input_path");
        }
        files.push({ path: relative(root, absolute).split(sep).join("/"), absolute,
          metadata: metadata(info), size: Number(info.size) });
      }
      return files;
    };

    const before = await inventory();
    const digest = createHash("sha256");
    digest.update(JSON.stringify({ policy: VALIDATION_INPUT_POLICY, scope: scope.kind, workspaceKey,
      rootDevice: rootInfo.dev.toString(), rootInode: rootInfo.ino.toString() }));
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (const file of before) {
      checkTime();
      if (file.metadata === "missing") { digest.update(JSON.stringify([file.path, "missing"])); continue; }
      const handle = await fs.open(file.absolute, "r");
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || metadata(opened) !== file.metadata) throw new UnverifiableRevision("input_changed_during_capture");
        const fileDigest = createHash("sha256");
        let offset = 0;
        for (;;) {
          checkTime();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > file.size) throw new UnverifiableRevision("input_changed_during_capture");
          fileDigest.update(buffer.subarray(0, bytesRead));
        }
        if (offset !== file.size || metadata(await handle.stat({ bigint: true })) !== file.metadata ||
            metadata(await fs.lstat(file.absolute, { bigint: true })) !== file.metadata ||
            normalizeKey(await fs.realpath(file.absolute)) !== normalizeKey(file.absolute)) {
          throw new UnverifiableRevision("input_changed_during_capture");
        }
        digest.update(JSON.stringify([file.path, file.metadata, fileDigest.digest("hex")]));
      } finally { await handle.close(); }
    }
    const after = await inventory();
    const afterRoot = await fs.stat(root, { bigint: true });
    if (rootInfo.dev !== afterRoot.dev || rootInfo.ino !== afterRoot.ino ||
        normalizeKey(await fs.realpath(targetDir)) !== workspaceKey || !sameInventory(before, after)) {
      throw new UnverifiableRevision("input_inventory_changed");
    }
    checkTime();
    return { workspaceKey, fingerprint: digest.digest("hex") };
  } catch (error) {
    return { workspaceKey, fingerprint: null,
      reason: options.signal?.aborted ? "capture_cancelled" : error instanceof UnverifiableRevision ? error.message : "input_read_failed" };
  }
};

const metadata = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
const sameInventory = (before: InputFile[], after: InputFile[]): boolean => before.length === after.length &&
  before.every((file, index) => file.path === after[index]?.path && file.metadata === after[index]?.metadata);
const limit = (value: number | undefined, fallback: number): number =>
  value === undefined ? fallback : Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const discoverScope = async (root: string, timeoutMs: number, signal?: AbortSignal): Promise<InputScope> => {
  try {
    const output = await runGit(root, ["rev-parse", "--show-toplevel"], timeoutMs, signal);
    const gitRoot = await fs.realpath(output.replace(/\r?\n$/, ""));
    if (!inside(gitRoot, root)) throw new UnverifiableRevision("git_scope_mismatch");
    return { kind: "git", gitRoot };
  } catch (error) {
    if (signal?.aborted) throw new UnverifiableRevision("capture_cancelled");
    if (error instanceof UnverifiableRevision) throw error;
    if (await hasGitSentinel(root)) throw new UnverifiableRevision("git_scope_unavailable");
    return { kind: "plain" };
  }
};

const requireUnambiguousMissingPath = async (root: string, path: string): Promise<void> => {
  for (let probe = dirname(path); inside(root, probe); probe = dirname(probe)) {
    try {
      const info = await fs.lstat(probe, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() ||
          normalizeKey(await fs.realpath(probe)) !== normalizeKey(probe)) {
        throw new UnverifiableRevision("ambiguous_input_path");
      }
      return;
    } catch (error) { if (!isMissing(error)) throw error; }
    if (probe === root) break;
  }
  throw new UnverifiableRevision("input_inventory_changed");
};

const hasGitSentinel = async (root: string): Promise<boolean> => {
  for (let directory = root;;) {
    try { await fs.lstat(resolve(directory, ".git")); return true; }
    catch (error) { if (!isMissing(error)) throw new UnverifiableRevision("git_scope_unavailable"); }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
};

const runGit = (cwd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> => new Promise((fulfill, reject) => {
  // Ignore caller Git overrides/tracing and disable filesystem-monitor helpers.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  childProcess.execFile("git", ["-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", cwd, ...args], {
    env, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: Math.min(10_000, timeoutMs),
    ...(signal ? { signal } : {}),
  }, (error, stdout) => error ? reject(error) : fulfill(stdout));
});
