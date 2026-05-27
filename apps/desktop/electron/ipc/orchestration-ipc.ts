import { ipcMain } from "electron";
import { IPC_CHANNELS } from "@harness/core";
import type { OrchestrationService } from "@harness/orchestration";
import type { HarnessEventBus } from "../event-bus";
import { buildOrchestrationHandlers } from "./orchestration-ipc-handlers";

export const registerOrchestrationIpc = (
  service: OrchestrationService,
  events: HarnessEventBus,
): void => {
  const h = buildOrchestrationHandlers({ service, events });
  ipcMain.handle(IPC_CHANNELS.orchestration.getPlan, async (_e, input) =>
    h.getPlan(input),
  );
  ipcMain.handle(IPC_CHANNELS.orchestration.draftPlan, async (_e, input) =>
    h.draftPlan(input),
  );
  ipcMain.handle(IPC_CHANNELS.orchestration.runApproved, async (_e, input) =>
    h.runApproved(input),
  );
};
