import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import {
  buildSkillSourceHandlers,
  type SkillSourceIpcContext,
} from "./skill-source-ipc.ts";

export const registerSkillSourceIpc = (ctx: SkillSourceIpcContext): void => {
  const h = buildSkillSourceHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.skillSource.list, async () => h.list());
  ipcMain.handle(IPC_CHANNELS.skillSource.add, async (_e, input) =>
    h.add(input),
  );
  ipcMain.handle(IPC_CHANNELS.skillSource.update, async (_e, input) =>
    h.update(input),
  );
  ipcMain.handle(IPC_CHANNELS.skillSource.remove, async (_e, input) =>
    h.remove(input),
  );
  ipcMain.handle(IPC_CHANNELS.skillSource.refresh, async (_e, input) =>
    h.refresh(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skillSource.generateSkillDraft,
    async (_e, input) => h.generateSkillDraft(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skillSource.previewSkillDraft,
    async (_e, input) => h.previewSkillDraft(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skillSource.proposeSkillFile,
    async (_e, input) => h.proposeSkillFile(input),
  );
};
