import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import {
  buildRemoteAgentsHandlers,
  type RemoteAgentsIpcContext,
} from "./remote-agents-ipc";

export const registerRemoteAgentsIpc = (
  ctx: RemoteAgentsIpcContext,
): void => {
  const h = buildRemoteAgentsHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.remoteAgents.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.remoteAgents.get, async (_e, input) =>
    h.get(input),
  );
  ipcMain.handle(IPC_CHANNELS.remoteAgents.upsertEndpoint, async (_e, input) =>
    h.upsertEndpoint(input),
  );
  ipcMain.handle(IPC_CHANNELS.remoteAgents.delete, async (_e, input) =>
    h.delete(input),
  );
  ipcMain.handle(IPC_CHANNELS.remoteAgents.toggle, async (_e, input) =>
    h.toggle(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.remoteAgents.upsertCardSnapshot,
    async (_e, input) => h.upsertCardSnapshot(input),
  );
};

