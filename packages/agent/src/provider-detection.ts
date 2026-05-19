import { spawn } from "node:child_process";
import type {
  AgentProvider,
  AgentProviderProbe,
  AgentProviderStatusMap,
} from "@harness/core";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from "@harness/core";
import { getProviderCommandCandidates } from "./provider-executable.ts";

/**
 * Provider preference resolution: model name → provider.
 * Source: legacy ClaudeAgentSystem model-invoker-cli.mjs (per phase-08 §1).
 *
 * `claude-*` → claude CLI, `gpt*`/`codex*`/`o*` → codex CLI.
 */
export const providerForModel = (model: string): AgentProvider | null => {
  const m = model.trim().toLowerCase();
  if (m.length === 0) return null;
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || m.startsWith("codex") || m.startsWith("o"))
    return "codex";
  return null;
};

export const defaultModelFor = (provider: AgentProvider): string =>
  provider === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;

export const normalizeModelForProvider = (
  provider: AgentProvider,
  preferred: string | undefined,
): string => {
  const model = preferred?.trim();
  if (!model) return defaultModelFor(provider);
  if (provider === "codex" && isUnsupportedCodexChatGptModel(model)) {
    return defaultModelFor(provider);
  }
  if (providerForModel(model) === provider) return model;
  return defaultModelFor(provider);
};

const isUnsupportedCodexChatGptModel = (model: string): boolean =>
  model.trim().toLowerCase() === "gpt-5";

/**
 * Probe a single CLI binary with `<bin> --version`. Returns availability
 * + the version string when present. Network access is not required —
 * if the binary isn't installed we just see ENOENT and report unavailable.
 *
 * Phase 8 default timeout: 3s. The probe is run twice on app boot
 * (once per provider) so the upper bound is 6s before the workbench
 * renders runtime status; AgentProviderStatus is rendered before probes
 * complete and switches when they do.
 */
export const probeProvider = (
  binary: string,
  options: { timeoutMs?: number; queueDepth?: number } = {},
): Promise<AgentProviderProbe> => {
  const candidates =
    binary === "claude" || binary === "codex"
      ? getProviderCommandCandidates(binary)
      : [binary];
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
  /** Per-provider depth getter; main process passes the queue ref. */
  getQueueDepth?: (provider: "claude" | "codex") => number;
  timeoutMs?: number;
}

/**
 * Probe both providers in parallel. Result is *not* cached here —
 * the caller decides whether to memoize. RuntimeStatusBar polls this
 * on demand so the user can re-check after installing a CLI.
 */
export const checkProviders = async (
  options: CheckProvidersOptions = {},
): Promise<AgentProviderStatusMap> => {
  const claudeDepth = options.getQueueDepth?.("claude") ?? 0;
  const codexDepth = options.getQueueDepth?.("codex") ?? 0;
  const claudeOptions: { timeoutMs?: number; queueDepth: number } = {
    queueDepth: claudeDepth,
  };
  if (options.timeoutMs !== undefined) claudeOptions.timeoutMs = options.timeoutMs;
  const codexOptions: { timeoutMs?: number; queueDepth: number } = {
    queueDepth: codexDepth,
  };
  if (options.timeoutMs !== undefined) codexOptions.timeoutMs = options.timeoutMs;
  const [claude, codex] = await Promise.all([
    probeProvider("claude", claudeOptions),
    probeProvider("codex", codexOptions),
  ]);
  return { claude, codex };
};
