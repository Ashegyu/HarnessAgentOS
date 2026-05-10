import { app } from "electron";
import type { RuntimeInfo, RuntimePlatform } from "@harness/core";

/**
 * Runtime info service. Phase 0 only reads stable Electron paths.
 * Later phases may extend with more system context, but renderer must
 * never receive raw filesystem capabilities through this surface.
 */
export const runtimeService = {
  getVersion(): string {
    return app.getVersion();
  },

  getRuntimeInfo(): RuntimeInfo {
    const info: RuntimeInfo = {
      platform: process.platform as RuntimePlatform,
      appDataDir: app.getPath("userData"),
      appVersion: app.getVersion(),
    };
    try {
      info.documentsDir = app.getPath("documents");
    } catch {
      // documents path may not exist on every platform; leave undefined.
    }
    return info;
  },
};
