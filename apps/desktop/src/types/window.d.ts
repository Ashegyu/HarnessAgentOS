import type { HarnessDesktopApi } from "@harness/core";

declare global {
  interface Window {
    /** Typed IPC only, including bounded state.listRecentTaskRuns; main owns progression. */
    harness: HarnessDesktopApi;
  }
}

export {};
