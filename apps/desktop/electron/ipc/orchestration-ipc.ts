import { handleIpc } from "./ipc-lifecycle";

import { IPC_CHANNELS } from "@harness/core";
import type { OrchestrationService } from "@harness/orchestration";
import type { HarnessEventBus } from "../event-bus";
import { buildOrchestrationHandlers } from "./orchestration-ipc-handlers";

export const registerOrchestrationIpc = (
  service: OrchestrationService,
  events: HarnessEventBus,
): void => {
  const h = buildOrchestrationHandlers({ service, events });
  handleIpc(IPC_CHANNELS.orchestration.getPlan, async (_e, input) =>
    h.getPlan(input),
  );
  handleIpc(IPC_CHANNELS.orchestration.draftPlan, async (_e, input) =>
    h.draftPlan(input),
  );
  handleIpc(IPC_CHANNELS.orchestration.runApproved, async (_e, input) =>
    h.runApproved(input),
  );
};
