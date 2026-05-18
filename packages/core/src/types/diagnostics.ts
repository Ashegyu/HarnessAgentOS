import type { AgentProviderStatusMap } from "./agent-invocation.ts";

export type DiagnosticsStatus = "ok" | "warning" | "error";

export interface DatabaseDiagnosticsSnapshot {
  mainBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  walCheckpoint: {
    busy: number;
    log: number;
    checkpointed: number;
  };
}

export interface AgentQueueDepths {
  claude: number;
  codex: number;
  total: number;
}

export interface SystemDiagnostics {
  generatedAt: string;
  thresholds: {
    dbWarnBytes: number;
    queueDepthWarn: number;
  };
  db: DatabaseDiagnosticsSnapshot & {
    status: DiagnosticsStatus;
    warning?: string;
  };
  queue: AgentQueueDepths & {
    status: DiagnosticsStatus;
    warning?: string;
  };
  providers: {
    status: DiagnosticsStatus;
    items: AgentProviderStatusMap;
    warning?: string;
  };
  runner: {
    inflightCount: number;
    status: DiagnosticsStatus;
  };
}
