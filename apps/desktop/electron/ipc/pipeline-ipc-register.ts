import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import {
  buildPipelineHandlers,
  type PipelineIpcContext,
} from "./pipeline-ipc.ts";

export const registerPipelineIpc = (ctx: PipelineIpcContext): void => {
  const h = buildPipelineHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.pipeline.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.pipeline.get, async (_e, input) => h.get(input));
  ipcMain.handle(IPC_CHANNELS.pipeline.create, async (_e, input) =>
    h.create(input),
  );
  ipcMain.handle(IPC_CHANNELS.pipeline.update, async (_e, input) =>
    h.update(input),
  );
  ipcMain.handle(IPC_CHANNELS.pipeline.delete, async (_e, input) =>
    h.delete(input),
  );
};
