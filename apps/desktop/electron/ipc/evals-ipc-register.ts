import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import { buildEvalsHandlers, type EvalsIpcContext } from "./evals-ipc.ts";

export const registerEvalsIpc = (ctx: EvalsIpcContext): void => {
  const handlers = buildEvalsHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.evals.listRuns, async (_event, input) =>
    handlers.listRuns(input ?? {}),
  );
  ipcMain.handle(IPC_CHANNELS.evals.getRun, async (_event, input) =>
    handlers.getRun(input),
  );
};
