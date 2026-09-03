import { spawn } from "node:child_process";
import type {
  AgentProvider,
  AgentProviderProbe,
  AgentProviderStatusMap,
} from "@harness/core";
import {
  DEFAULT_CODEX_MODEL,
  isCodexModel,
  normalizeCodexModel,
} from "@harness/core";
import { getProviderCommandCandidates } from "./provider-executable.ts";

/**
 * Resolve only models that are selectable in the Codex-only catalogue.
 */
export const providerForModel = (model: string): AgentProvider | null => {
  return isCodexModel(model) ? "codex" : null;
};

export const defaultModelFor = (_provider: AgentProvider): string =>
  DEFAULT_CODEX_MODEL;

export const normalizeModelForProvider = (
  provider: AgentProvider,
  preferred: string | undefined,
): string => {
  void provider;
  return normalizeCodexModel(preferred);
};

/**
 * Probe a single CLI binary with `<bin> --version`. Returns availability
 * + the version string when present. Network access is not required —
 * if the binary isn't installed we just see ENOENT and report unavailable.
 *
 * Phase 8 default timeout: 3s. AgentProviderStatus renders before the
 * probe completes and switches when the Codex result arrives.
 */
export const probeProvider = (
  binary: string,
  options: { timeoutMs?: number; queueDepth?: number } = {},
): Promise<AgentProviderProbe> => {
  const candidates =
    binary === "codex" ? getProviderCommandCandidates("codex") : [binary];
  return probeProviderCandidates(candidates, options);
};

const probeProviderCandidates = async (
  candidates: readonly string[],
  options: { timeoutMs?: number; queueDepth?: number },
): Promise<AgentProviderProbe> => {
  let last: AgentProviderProbe | null = null;
  for (const command of candidates) {
    const probe = await probeProviderCommand(command, options);
    if (probe.available) return probe;
    last = probe;
  }
  return (
    last ?? {
      available: false,
      error: "no provider command candidates",
      command: candidates[0],
      queueDepth: options.queueDepth ?? 0,
    }
  );
};

const probeProviderCommand = (
  command: string,
  options: { timeoutMs?: number; queueDepth?: number } = {},
): Promise<AgentProviderProbe> => {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const queueDepth = options.queueDepth ?? 0;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (probe: AgentProviderProbe): void => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    let child;
    try {
      child = spawn(command, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (e) {
      settle({
        available: false,
        error: e instanceof Error ? e.message : String(e),
        command,
        queueDepth,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        available: false,
        error: `probe timeout after ${timeoutMs}ms`,
        command,
        queueDepth,
      });
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ available: false, error: err.message, command, queueDepth });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const version = parseVersion(stdout) ?? parseVersion(stderr);
        const probe: AgentProviderProbe = {
          available: true,
          command,
          queueDepth,
        };
        if (version) probe.version = version;
        settle(probe);
        return;
      }
      settle({
        available: false,
        error: stderr.trim() || `${command} --version exited with code ${code}`,
        command,
        queueDepth,
      });
    });
  });
};

const parseVersion = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  // Most CLIs emit a single line; otherwise take the first line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
};

export interface CheckProvidersOptions {
  /** Codex queue depth getter; main process passes the queue ref. */
  getQueueDepth?: (provider: AgentProvider) => number;
  timeoutMs?: number;
}

/**
 * Probe Codex. Result is *not* cached here —
 * the caller decides whether to memoize. RuntimeStatusBar polls this
 * on demand so the user can re-check after installing a CLI.
 */
export const checkProviders = async (
  options: CheckProvidersOptions = {},
): Promise<AgentProviderStatusMap> => {
  const codexDepth = options.getQueueDepth?.("codex") ?? 0;
  const codexOptions: { timeoutMs?: number; queueDepth: number } = {
    queueDepth: codexDepth,
  };
  if (options.timeoutMs !== undefined) codexOptions.timeoutMs = options.timeoutMs;
  const codex = await probeProvider("codex", codexOptions);
  return { codex };
};
