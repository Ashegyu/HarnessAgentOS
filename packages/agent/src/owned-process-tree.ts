import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** Only call with the PID returned by this invocation's spawn, before killing its root. */
export const terminateWindowsProcessTree = (
  pid: number,
  execute: typeof execFile = execFile,
): Promise<void> => new Promise((resolve, reject) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    reject(new Error("Refusing an invalid or host process PID"));
    return;
  }
  // Do not resolve taskkill through a workspace-controlled PATH/current directory.
  const command = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  execute(command, ["/PID", String(pid), "/T", "/F"], {
    shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
  }, (error) => {
    if (error) reject(new Error("Windows CLI process tree cleanup could not be confirmed"));
    else resolve();
  });
});
