import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { AgentProvider } from "@harness/core";

export interface ProviderCommandCandidateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  cliPathOverride?: string;
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
    if (provider === "codex") {
      pushExisting(
        env["LOCALAPPDATA"]
          ? win32.join(env["LOCALAPPDATA"], "OpenAI", "Codex", "bin", "codex.exe")
          : undefined,
      );
    } else {
      pushExisting(
        env["USERPROFILE"]
          ? win32.join(env["USERPROFILE"], ".local", "bin", "claude.exe")
          : undefined,
      );
    }
  }

  candidates.push(provider);
  return [...new Set(candidates)];
};

export const resolveProviderCommand = (
  provider: AgentProvider,
  cliPathOverride?: string,
): string => getProviderCommandCandidates(provider, { cliPathOverride })[0] ?? provider;
