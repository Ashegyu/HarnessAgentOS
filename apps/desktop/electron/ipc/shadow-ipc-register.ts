import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import { buildShadowHandlers, type ShadowIpcContext } from "./shadow-ipc.ts";
import type { HarnessEventBus } from "../event-bus";

export const registerShadowIpc = (
  ctx: ShadowIpcContext,
  events: HarnessEventBus,
): void => {
  const h = buildShadowHandlers(ctx);
  ipcMain.handle(IPC_CHANNELS.shadow.createPreview, async (_e, input) => {
    const result = await h.createPreview(input);
    if (result.ok) events.taskRunChanged(result.value.taskRunId);
    return result;
  });
};
