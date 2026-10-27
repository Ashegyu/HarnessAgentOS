import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import {
  buildHarnessPackageHandlers,
  type HarnessPackageIpcContext,
} from "./harness-package-ipc.ts";

export const registerHarnessPackageIpc = (
  ctx: HarnessPackageIpcContext,
): void => {
  const h = buildHarnessPackageHandlers(ctx);
  handleIpc(IPC_CHANNELS.harnessPackages.list, async () => h.list());
  handleIpc(IPC_CHANNELS.harnessPackages.get, async (_e, input) =>
    h.get(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.importDirectory,
    async (_e, input) => h.importDirectory(input),
  );
  handleIpc(IPC_CHANNELS.harnessPackages.repair, async (_e, input) =>
    h.repair(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.previewExport,
    async (_e, input) => h.previewExport(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.proposeExport,
    async (_e, input) => h.proposeExport(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.previewPipelineDraft,
    async (_e, input) => h.previewPipelineDraft(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.listBindingSets,
    async (_e, input) => h.listBindingSets(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.getBindingSet,
    async (_e, input) => h.getBindingSet(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.saveBindingSet,
    async (_e, input) => h.saveBindingSet(input),
  );
  handleIpc(
    IPC_CHANNELS.harnessPackages.removeBindingSet,
    async (_e, input) => h.removeBindingSet(input),
  );
  handleIpc(IPC_CHANNELS.harnessPackages.remove, async (_e, input) =>
    h.remove(input),
  );
};
