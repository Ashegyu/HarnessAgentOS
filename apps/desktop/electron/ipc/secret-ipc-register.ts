import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import { buildSecretHandlers, type SecretIpcContext } from "./secret-ipc.ts";

export const registerSecretIpc = (ctx: SecretIpcContext): void => {
  const h = buildSecretHandlers(ctx);
  handleIpc(IPC_CHANNELS.secret.write, async (_e, input) => h.write(input));
  handleIpc(IPC_CHANNELS.secret.clear, async (_e, input) => h.clear(input));
  handleIpc(IPC_CHANNELS.secret.listKeys, async () => h.listKeys());
};
