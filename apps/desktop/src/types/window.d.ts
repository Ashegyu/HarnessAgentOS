import type { HarnessDesktopApi } from "@harness/core";

declare global {
  interface Window {
    harness: HarnessDesktopApi;
  }
}

export {};
