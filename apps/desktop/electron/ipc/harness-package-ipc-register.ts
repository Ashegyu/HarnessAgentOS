import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import {
  buildHarnessPackageHandlers,
  type HarnessPackageIpcContext,
} from "./harness-package-ipc.ts";

export const registerHarnessPackageIpc = (
  ctx: HarnessPackageIpcContext,
): void => {
  const h = buildHarnessPackageHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.harnessPackages.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.harnessPackages.get, async (_e, input) =>
    h.get(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.importDirectory,
    async (_e, input) => h.importDirectory(input),
  );
  ipcMain.handle(IPC_CHANNELS.harnessPackages.repair, async (_e, input) =>
    h.repair(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.previewExport,
    async (_e, input) => h.previewExport(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.proposeExport,
    async (_e, input) => h.proposeExport(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.previewPipelineDraft,
    async (_e, input) => h.previewPipelineDraft(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.listBindingSets,
    async (_e, input) => h.listBindingSets(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.getBindingSet,
    async (_e, input) => h.getBindingSet(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.saveBindingSet,
    async (_e, input) => h.saveBindingSet(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.harnessPackages.removeBindingSet,
    async (_e, input) => h.removeBindingSet(input),
  );
  ipcMain.handle(IPC_CHANNELS.harnessPackages.remove, async (_e, input) =>
    h.remove(input),
  );
};
