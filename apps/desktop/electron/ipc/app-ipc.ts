import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type HarnessResult,
  type RuntimeInfo,
  ok,
  err,
  harnessError,
  APP_RUNTIME_UNAVAILABLE,
} from "@harness/core";
import { runtimeService } from "../services/runtime-service";

/**
 * `app` namespace IPC handlers. Each handler returns HarnessResult<T>;
 * preload unwraps to either resolved value or thrown HarnessError.
 */
export const registerAppIpc = (): void => {
  ipcMain.handle(
    IPC_CHANNELS.app.getVersion,
    async (): Promise<HarnessResult<string>> => {
      try {
        return ok(runtimeService.getVersion());
      } catch (e) {
        return err(
          harnessError(
            APP_RUNTIME_UNAVAILABLE,
            "Failed to read app version",
            String(e),
          ),
        );
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.app.getRuntimeInfo,
    async (): Promise<HarnessResult<RuntimeInfo>> => {
      try {
        return ok(runtimeService.getRuntimeInfo());
      } catch (e) {
        return err(
          harnessError(
            APP_RUNTIME_UNAVAILABLE,
            "Failed to read runtime info",
            String(e),
          ),
        );
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.app.selectDirectory,
    async (e): Promise<HarnessResult<string | null>> => {
      try {
        const win = BrowserWindow.fromWebContents(e.sender);
        const result = await (win
          ? dialog.showOpenDialog(win, {
              properties: ["openDirectory", "createDirectory"],
              title: "TaskRun targetDir 선택",
            })
          : dialog.showOpenDialog({
              properties: ["openDirectory", "createDirectory"],
              title: "TaskRun targetDir 선택",
            }));
        if (result.canceled || result.filePaths.length === 0) return ok(null);
        return ok(result.filePaths[0] ?? null);
      } catch (err2) {
        return err(
          harnessError(
            APP_RUNTIME_UNAVAILABLE,
            "Failed to open directory picker",
            String(err2),
          ),
        );
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.app.selectFile,
    async (e, input: unknown): Promise<HarnessResult<string | null>> => {
      try {
        const defaultPath =
          input &&
          typeof input === "object" &&
          typeof (input as { defaultDir?: unknown }).defaultDir === "string"
            ? ((input as { defaultDir: string }).defaultDir)
            : undefined;
        const win = BrowserWindow.fromWebContents(e.sender);
        // showSaveDialog supports both selecting an existing file and
        // typing a new name — exactly what file_write approvals need.
        const result = await (win
          ? dialog.showSaveDialog(win, {
              defaultPath,
              title: "file_write 대상 파일 선택",
              properties: ["createDirectory", "showOverwriteConfirmation"],
            })
          : dialog.showSaveDialog({
              defaultPath,
              title: "file_write 대상 파일 선택",
              properties: ["createDirectory", "showOverwriteConfirmation"],
            }));
        if (result.canceled || !result.filePath) return ok(null);
        return ok(result.filePath);
      } catch (err2) {
        return err(
          harnessError(
            APP_RUNTIME_UNAVAILABLE,
            "Failed to open file picker",
            String(err2),
          ),
        );
      }
    },
  );
};
