import { ipcMain } from "electron";
import { AsyncWorkScope, err, harnessError } from "@harness/core";

export const ipcWorkScope = new AsyncWorkScope();

/** All renderer requests remain owned until their result/cleanup settles. */
export const handleIpc = (
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void => ipcMain.handle(channel, (event, ...args) => {
  if (ipcWorkScope.closed) return err(harnessError("APPLICATION_SHUTTING_DOWN", "Application is shutting down"));
  return ipcWorkScope.run(() => listener(event, ...args));
});
