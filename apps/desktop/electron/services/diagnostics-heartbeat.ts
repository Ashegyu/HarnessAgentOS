import type { SystemDiagnostics } from "@harness/core";
import { AsyncWorkScope } from "@harness/core";

export interface DiagnosticsHeartbeatController {
  emitNow(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiagnosticsHeartbeatDeps {
  collect(): Promise<SystemDiagnostics>;
  emit(diagnostics: SystemDiagnostics): void;
  intervalMs?: number;
  setIntervalFn?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

export const startDiagnosticsHeartbeat = (
  deps: DiagnosticsHeartbeatDeps,
): DiagnosticsHeartbeatController => {
  const intervalMs = deps.intervalMs ?? 10_000;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  let stopped = false;
  let pending = false;
  const operations = new AsyncWorkScope();

  const emitNow = async (): Promise<void> => {
    if (stopped || pending) return;
    pending = true;
    await operations.run(async () => {
      try {
        const value = await deps.collect();
        if (!stopped) deps.emit(value);
      } catch {
        // Heartbeat failures must not crash the main process.
      } finally { pending = false; }
    });
  };

  const timer = setIntervalFn(() => {
    void emitNow();
  }, intervalMs);

  return {
    emitNow,
    stop() {
      if (!stopped) { stopped = true; clearIntervalFn(timer); }
      operations.seal();
      return operations.drain();
    },
  };
};
