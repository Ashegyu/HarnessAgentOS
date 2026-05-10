import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  ORCH_INVALID_PLAN,
  ORCH_PLAN_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type Approval,
  type Artifact,
  type HarnessResult,
  type OrchestrationMode,
  type OrchestrationPlan,
  type OrchestrationRunResult,
} from "@harness/core";
import {
  ORCHESTRATION_MODES,
  OrchestrationError,
  OrchestrationService,
} from "@harness/orchestration";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown, code = ORCH_PLAN_NOT_FOUND): HarnessResult<T> => {
  if (e instanceof OrchestrationError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(code, msg));
};

const isOrchestrationMode = (v: unknown): v is OrchestrationMode =>
  typeof v === "string" &&
  (ORCHESTRATION_MODES as readonly string[]).includes(v);

export const registerOrchestrationIpc = (
  service: OrchestrationService,
  events: HarnessEventBus,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.orchestration.getPlan,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<OrchestrationPlan | null>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      try {
        if (!service.isEnabled()) return ok(null);
        return ok(await service.getLatestPlan({ taskRunId: cast.taskRunId }));
      } catch (e) {
        return wrapErr<OrchestrationPlan | null>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.orchestration.draftPlan,
    async (
      _e,
      input: unknown,
    ): Promise<
      HarnessResult<{
        plan: OrchestrationPlan;
        artifact: Artifact;
        approval: Approval;
      }>
    > => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        mode?: unknown;
        instruction?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (!isOrchestrationMode(cast.mode)) {
        return err(harnessError(ORCH_INVALID_PLAN, "Unknown orchestration mode"));
      }
      const payload: Parameters<typeof service.draftPlan>[0] = {
        taskRunId: cast.taskRunId,
        mode: cast.mode,
      };
      if (typeof cast.instruction === "string")
        payload.instruction = cast.instruction;
      try {
        const drafted = await service.draftPlan(payload);
        events.taskRunChanged(drafted.plan.taskRunId);
        return ok(drafted);
      } catch (e) {
        return wrapErr<{
          plan: OrchestrationPlan;
          artifact: Artifact;
          approval: Approval;
        }>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.orchestration.runApproved,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<OrchestrationRunResult>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { approvalId?: unknown };
      if (!isNonEmptyString(cast.approvalId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "approvalId must be non-empty string"),
        );
      }
      try {
        const result = await service.runApproved({ approvalId: cast.approvalId });
        events.taskRunChanged(result.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapErr<OrchestrationRunResult>(e);
      }
    },
  );
};
