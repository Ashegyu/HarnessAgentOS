import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface DeriveProjectKeyInput {
  targetDir: string;
}

export const deriveProjectKey = async (
  input: DeriveProjectKeyInput,
): Promise<string> => {
  const resolved = await realpath(input.targetDir).catch(() => input.targetDir);
  const remote = await readOriginRemoteUrl(resolved).catch(() => null);
  return projectKeyFromParts({
    targetDir: resolved,
    remoteUrl: remote,
  });
};

export const projectKeyFromParts = (input: {
  targetDir: string;
  remoteUrl?: string | null;
}): string => {
  const normalizedPath = input.targetDir
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
  const remote = normalizeRemoteUrl(input.remoteUrl ?? "");
  const hash = createHash("sha256")
    .update(`${normalizedPath}\n${remote}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `proj_${hash}`;
};

const readOriginRemoteUrl = async (
  targetDir: string,
): Promise<string | null> => {
  const config = await readFile(join(targetDir, ".git", "config"), "utf8");
  let inOrigin = false;
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    const url = match?.[1]?.trim();
    if (url) return url;
  }
  return null;
};

const normalizeRemoteUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/g, "").toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};
