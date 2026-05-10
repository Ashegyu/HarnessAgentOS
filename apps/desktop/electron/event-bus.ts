import { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "@harness/core";

/**
 * One-way main → renderer broadcaster. IPC handlers call
 * `taskRunChanged(id)` after any successful state-changing op so
 * subscribed renderer windows can refetch without polling.
 *
 * Module-level singleton — there is exactly one main process.
 */
const broadcast = (channel: string, payload: unknown): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
};

export interface HarnessEventBus {
  taskRunChanged(taskRunId: string): void;
}

export const eventBus: HarnessEventBus = {
  taskRunChanged(taskRunId) {
    if (!taskRunId) return;
    broadcast(IPC_CHANNELS.events.taskRunChanged, { taskRunId });
  },
};
