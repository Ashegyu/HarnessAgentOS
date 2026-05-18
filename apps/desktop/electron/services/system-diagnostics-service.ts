import type {
  AgentProviderStatusMap,
  AgentQueueDepths,
  DatabaseDiagnosticsSnapshot,
  DiagnosticsStatus,
  SystemDiagnostics,
} from "@harness/core";

export const SYSTEM_DIAGNOSTICS_THRESHOLDS = {
  dbWarnBytes: 100 * 1024 * 1024,
  queueDepthWarn: 5,
} as const;

export interface SystemDiagnosticsServiceDeps {
  database: {
    getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot;
  };
  agentPlanning: {
    getQueueDepths(): AgentQueueDepths;
  };
  runner: {
    getInflightCount(): number;
  };
  probeProviders(): Promise<AgentProviderStatusMap>;
  now?: () => string;
  providerCacheMs?: number;
}

export class SystemDiagnosticsService {
  private readonly deps: SystemDiagnosticsServiceDeps;
  private providerCache:
    | { capturedAtMs: number; value: AgentProviderStatusMap }
    | null = null;

  constructor(deps: SystemDiagnosticsServiceDeps) {
    this.deps = deps;
  }

  async collect(): Promise<SystemDiagnostics> {
    const generatedAt = this.deps.now?.() ?? new Date().toISOString();
    const dbSnapshot = this.deps.database.getDatabaseDiagnostics();
    const queueDepths = this.deps.agentPlanning.getQueueDepths();
    const providers = await this.providerSnapshot();
    const providerWarning = providersWarning(providers);
    const dbWarning =
      dbSnapshot.totalBytes > SYSTEM_DIAGNOSTICS_THRESHOLDS.dbWarnBytes
        ? `SQLite files exceed ${formatBytes(
            SYSTEM_DIAGNOSTICS_THRESHOLDS.dbWarnBytes,
          )}`
        : undefined;
    const queueWarning =
      queueDepths.total > SYSTEM_DIAGNOSTICS_THRESHOLDS.queueDepthWarn
        ? `Agent queue depth exceeds ${SYSTEM_DIAGNOSTICS_THRESHOLDS.queueDepthWarn}`
        : undefined;
    return {
      generatedAt,
      thresholds: SYSTEM_DIAGNOSTICS_THRESHOLDS,
      db: {
        ...dbSnapshot,
        status: dbWarning ? "warning" : "ok",
        ...(dbWarning ? { warning: dbWarning } : {}),
      },
      queue: {
        ...queueDepths,
        status: queueWarning ? "warning" : "ok",
        ...(queueWarning ? { warning: queueWarning } : {}),
      },
      providers: {
        status: providerWarning ? "warning" : "ok",
        items: providers,
        ...(providerWarning ? { warning: providerWarning } : {}),
      },
      runner: {
        inflightCount: this.deps.runner.getInflightCount(),
        status: "ok",
      },
    };
  }

  private async providerSnapshot(): Promise<AgentProviderStatusMap> {
    const cacheMs = this.deps.providerCacheMs ?? 30_000;
    const nowMs = Date.now();
    if (
      this.providerCache &&
      nowMs - this.providerCache.capturedAtMs < cacheMs
    ) {
      return this.providerCache.value;
    }
    try {
      const value = await this.deps.probeProviders();
      this.providerCache = { capturedAtMs: nowMs, value };
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailableProviders(message);
    }
  }
}

const unavailableProviders = (message: string): AgentProviderStatusMap => ({
  claude: { available: false, error: message, queueDepth: 0 },
  codex: { available: false, error: message, queueDepth: 0 },
});

const providersWarning = (
  providers: AgentProviderStatusMap,
): string | undefined => {
  if (providers.claude.available || providers.codex.available) return undefined;
  return "No local agent provider is currently available";
};

const formatBytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`;

export const diagnosticsStatusTone = (
  status: DiagnosticsStatus,
): "passed" | "warning" | "failed" => {
  if (status === "error") return "failed";
  if (status === "warning") return "warning";
  return "passed";
};
