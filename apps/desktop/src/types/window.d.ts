import type { HarnessDesktopApi } from "@harness/core";

declare global {
  interface Window {
    /** Typed IPC only; conversation.startTask submits once, main owns progression. */
    harness: HarnessDesktopApi;
  }
}

export {};
