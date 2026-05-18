import { BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  type AgentStreamEvent,
  type SystemDiagnostics,
} from "@harness/core";

/**
 * One-way main → renderer broadcaster. IPC handlers call
 * `taskRunChanged(id)` after any successful state-changing op so
 * subscribed renderer windows can refetch without polling.
 *
 * Phase 8 adds `agentStreamEvent(...)` — a scoped chunk channel
 * carrying invocationId-tagged events for live agent CLI output. The
 * caller is responsible for redacting secrets before broadcast.
 *
 * Module-level singleton — there is exactly one main process.
 */
const broadcast = (channel: string, payload: unknown): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
};

let diagnosticsEmitter: (() => void) | null = null;

export const setDiagnosticsEmitter = (emitter: (() => void) | null): void => {
  diagnosticsEmitter = emitter;
};

const requestDiagnostics = (): void => {
  diagnosticsEmitter?.();
};

export interface HarnessEventBus {
  taskRunChanged(taskRunId: string): void;
  agentStreamEvent(event: AgentStreamEvent): void;
  diagnosticsHeartbeat(diagnostics: SystemDiagnostics): void;
}

export const eventBus: HarnessEventBus = {
  taskRunChanged(taskRunId) {
    if (!taskRunId) return;
    broadcast(IPC_CHANNELS.events.taskRunChanged, { taskRunId });
    requestDiagnostics();
  },
  agentStreamEvent(event) {
    if (!event || typeof event !== "object") return;
    broadcast(IPC_CHANNELS.events.agentStreamEvent, event);
    if (shouldRefreshDiagnostics(event)) requestDiagnostics();
  },
  diagnosticsHeartbeat(diagnostics) {
    broadcast(IPC_CHANNELS.events.diagnosticsHeartbeat, diagnostics);
  },
};

const shouldRefreshDiagnostics = (event: AgentStreamEvent): boolean =>
  event.type === "started" ||
  event.type === "result" ||
  event.type === "failed" ||
  event.type === "cancelled";
