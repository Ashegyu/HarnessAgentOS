import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import { buildEvalsHandlers, type EvalsIpcContext } from "./evals-ipc.ts";

export const registerEvalsIpc = (ctx: EvalsIpcContext): void => {
  const handlers = buildEvalsHandlers(ctx);
  handleIpc(IPC_CHANNELS.evals.listRuns, async (_event, input) =>
    handlers.listRuns(input ?? {}),
  );
  handleIpc(IPC_CHANNELS.evals.getRun, async (_event, input) =>
    handlers.getRun(input),
  );
  handleIpc(IPC_CHANNELS.evals.getCostTrend, async (_event, input) =>
    handlers.getCostTrend(input ?? {}),
  );
  handleIpc(
    IPC_CHANNELS.evals.getRuntimeLatencySummary,
    async (_event, input) => handlers.getRuntimeLatencySummary(input ?? {}),
  );
};
