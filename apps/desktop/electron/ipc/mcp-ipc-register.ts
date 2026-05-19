import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import { buildMcpHandlers, type McpIpcContext } from "./mcp-ipc.ts";

export const registerMcpIpc = (ctx: McpIpcContext): void => {
  const h = buildMcpHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.mcp.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.mcp.generateServerDraft, async (_e, input) =>
    h.generateServerDraft(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.mcp.generateProfileBindingProposal,
    async (_e, input) => h.generateProfileBindingProposal(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.mcp.applyProfileBindingProposal,
    async (_e, input) => h.applyProfileBindingProposal(input),
  );
  ipcMain.handle(IPC_CHANNELS.mcp.upsert, async (_e, input) => h.upsert(input));
  ipcMain.handle(IPC_CHANNELS.mcp.delete, async (_e, input) => h.delete(input));
  ipcMain.handle(IPC_CHANNELS.mcp.toggle, async (_e, input) => h.toggle(input));
  ipcMain.handle(IPC_CHANNELS.mcp.healthCheck, async (_e, input) =>
    h.healthCheck(input),
  );
};
