import { existsSync, readdirSync, statSync } from "node:fs";
import { win32 } from "node:path";
import type { AgentProvider } from "@harness/core";

export interface ProviderCommandCandidateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  cliPathOverride?: string;
  listDirectories?: (root: string) => { name: string; modifiedAt: number }[];
}

export const getProviderCommandCandidates = (
  provider: AgentProvider,
  options: ProviderCommandCandidateOptions = {},
): string[] => {
  const override = options.cliPathOverride?.trim();
  if (override) return [override];

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const candidates: string[] = [];

  const pushExisting = (path: string | undefined): void => {
    if (!path) return;
    if (exists(path)) candidates.push(path);
  };

  if (platform === "win32") {
    for (const candidate of windowsCodexCandidates(env)) {
      pushExisting(candidate);
    }
    const localAppData = env["LOCALAPPDATA"];
    if (localAppData) {
      const root = win32.join(localAppData, "OpenAI", "Codex", "bin");
      try {
        // Desktop updates install into versioned directories. Explorer does not
        // inherit the version-specific PATH injected into a Codex terminal.
        const versions = (options.listDirectories ?? listInstallDirectories)(root)
          .filter(row => /^[a-z0-9][a-z0-9._-]*$/i.test(row.name))
          .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
        for (const version of versions) {
          pushExisting(win32.join(root, version.name, "codex.exe"));
        }
      } catch {
        // Missing or inaccessible desktop installs must not hide npm/PATH CLIs.
      }
    }
  }

  candidates.push(provider);
  return [...new Set(candidates)];
};

const listInstallDirectories = (root: string): { name: string; modifiedAt: number }[] =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    try {
      const executable = statSync(win32.join(root, entry.name, "codex.exe"));
      return executable.isFile() ? [{ name: entry.name, modifiedAt: executable.mtimeMs }] : [];
    } catch {
      // An update can leave an incomplete installation beside the usable one.
      return [];
    }
  });

export const resolveProviderCommand = (
  provider: AgentProvider,
  cliPathOverride?: string,
): string => getProviderCommandCandidates(provider, { cliPathOverride })[0] ?? provider;

const windowsCodexCandidates = (env: NodeJS.ProcessEnv): string[] => {
  const candidates: string[] = [];
  const appData = env["APPDATA"];
  const localAppData = env["LOCALAPPDATA"];
  if (appData) {
    candidates.push(codexNpmNativePath(appData));
  }

  for (const dir of splitWindowsPath(env)) {
    candidates.push(win32.join(dir, "codex.exe"));
  }

  if (localAppData) {
    candidates.push(
      win32.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"),
    );
  }

  return [...new Set(candidates)];
};

const codexNpmNativePath = (appData: string): string =>
  win32.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "codex",
    "codex.exe",
  );

const splitWindowsPath = (env: NodeJS.ProcessEnv): string[] => {
  const pathValue = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  return pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};
