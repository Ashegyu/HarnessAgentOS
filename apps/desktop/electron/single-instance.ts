import type { App, BrowserWindow } from "electron";

type InstanceWindow = Pick<BrowserWindow, "isDestroyed" | "isMinimized" | "restore" | "show" | "focus">;

/** Only the lock owner may open/recover SQLite or start application services. */
export const startPrimaryInstance = (input: {
  app: Pick<App, "requestSingleInstanceLock" | "quit" | "on" | "whenReady">;
  getWindow: () => InstanceWindow | null;
  start: () => void | Promise<void>;
  onError: (error: unknown) => void;
}): boolean => {
  if (!input.app.requestSingleInstanceLock()) {
    input.app.quit();
    return false;
  }

  input.app.on("second-instance", () => {
    const window = input.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void input.app.whenReady().then(input.start).catch(input.onError);
  return true;
};
