import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type HarnessResult,
  type TopologyRecommendation,
} from "@harness/core";
import type { TopologyAdvisor } from "@harness/learner";
import { buildTopologyHandlers } from "./topology-ipc.ts";

export const registerTopologyIpc = (advisor: TopologyAdvisor): void => {
  const handlers = buildTopologyHandlers(advisor);
  ipcMain.handle(
    IPC_CHANNELS.topology.recommend,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<TopologyRecommendation[]>> =>
      handlers.recommend(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.topology.recordFeedback,
    async (_e, input: unknown): Promise<HarnessResult<null>> =>
      handlers.recordFeedback(input),
  );
};
