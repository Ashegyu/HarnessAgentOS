import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import {
  buildPipelineHandlers,
  type PipelineIpcContext,
} from "./pipeline-ipc.ts";

export const registerPipelineIpc = (ctx: PipelineIpcContext): void => {
  const h = buildPipelineHandlers(ctx);
  handleIpc(IPC_CHANNELS.pipeline.list, async () => h.list());
  handleIpc(IPC_CHANNELS.pipeline.get, async (_e, input) => h.get(input));
  handleIpc(IPC_CHANNELS.pipeline.create, async (_e, input) =>
    h.create(input),
  );
  handleIpc(IPC_CHANNELS.pipeline.update, async (_e, input) =>
    h.update(input),
  );
  handleIpc(IPC_CHANNELS.pipeline.delete, async (_e, input) =>
    h.delete(input),
  );
};
