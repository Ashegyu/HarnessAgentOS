import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import { buildAgentsHandlers, type AgentsIpcContext } from "./agents-ipc.ts";

/**
 * Electron-bound wiring for the `agents:*` IPC channels. Kept in its own
 * file so the handler logic in `agents-ipc.ts` stays importable from
 * plain-Node unit tests (importing `electron` outside an Electron runtime
 * throws).
 */
export const registerAgentsIpc = (ctx: AgentsIpcContext): void => {
  const h = buildAgentsHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.agents.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.agents.get, async (_e, input) => h.get(input));
  ipcMain.handle(IPC_CHANNELS.agents.create, async (_e, input) =>
    h.create(input),
  );
  ipcMain.handle(IPC_CHANNELS.agents.update, async (_e, input) =>
    h.update(input),
  );
  ipcMain.handle(IPC_CHANNELS.agents.delete, async (_e, input) =>
    h.delete(input),
  );
  ipcMain.handle(IPC_CHANNELS.agents.setDefault, async (_e, input) =>
    h.setDefault(input),
  );
  ipcMain.handle(IPC_CHANNELS.agents.setActive, async (_e, input) =>
    h.setActive(input),
  );
};
