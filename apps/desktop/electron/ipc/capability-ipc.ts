import { ipcMain } from "electron";
import {
  CAPABILITY_REFRESH_FAILED,
  IPC_CHANNELS,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type Approval,
  type Capability,
  type CapabilityCandidateApprovalResult,
  type CapabilitySuggestion,
  type HarnessResult,
  type SkillResources,
} from "@harness/core";
import {
  CapabilityRegistry,
  CapabilityService,
  CapabilityServiceError,
  type SkillSourceConfig,
} from "@harness/skillify-adapter";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown, fallbackCode: string): HarnessResult<T> => {
  if (e instanceof CapabilityServiceError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(fallbackCode, msg));
};

export const registerCapabilityIpc = (
  service: CapabilityService,
  registry: CapabilityRegistry,
  sources: SkillSourceConfig[],
  events?: HarnessEventBus,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.capability.list,
    async (): Promise<HarnessResult<Capability[]>> => {
      try {
        return ok(await service.list());
      } catch (e) {
        return wrapErr<Capability[]>(e, CAPABILITY_REFRESH_FAILED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.capability.refresh,
    async (): Promise<HarnessResult<Capability[]>> => {
      try {
        return ok(await registry.refresh(sources));
      } catch (e) {
        return wrapErr<Capability[]>(e, CAPABILITY_REFRESH_FAILED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.capability.suggest,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<CapabilitySuggestion[]>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; prompt?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (typeof cast.prompt !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "prompt must be a string"));
      }
      try {
        const suggestions = await service.suggest({
          taskRunId: cast.taskRunId,
          prompt: cast.prompt,
        });
        return ok(suggestions);
      } catch (e) {
        return wrapErr<CapabilitySuggestion[]>(e, CAPABILITY_REFRESH_FAILED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.capability.readSkill,
    async (
      _e,
      input: unknown,
    ): Promise<
      HarnessResult<{
        capability: Capability;
        instructions: string;
        resources: SkillResources;
      }>
    > => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { capabilityId?: unknown };
      if (!isNonEmptyString(cast.capabilityId)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "capabilityId must be non-empty string",
          ),
        );
      }
      try {
        return ok(await service.readSkill({ capabilityId: cast.capabilityId }));
      } catch (e) {
        return wrapErr<{
          capability: Capability;
          instructions: string;
          resources: SkillResources;
        }>(e, CAPABILITY_REFRESH_FAILED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.capability.proposeCandidates,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<CapabilityCandidateApprovalResult>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; prompt?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (typeof cast.prompt !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "prompt must be a string"));
      }
      try {
        const result = await service.proposeCandidateApprovals({
          taskRunId: cast.taskRunId,
          prompt: cast.prompt,
        });
        if (result.approvals.length > 0) {
          events?.taskRunChanged(cast.taskRunId);
        }
        return ok(result);
      } catch (e) {
        return wrapErr<CapabilityCandidateApprovalResult>(
          e,
          CAPABILITY_REFRESH_FAILED,
        );
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.capability.proposeScriptRun,
    async (_e, input: unknown): Promise<HarnessResult<Approval>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        capabilityId?: unknown;
        taskRunId?: unknown;
        scriptName?: unknown;
      };
      if (
        !isNonEmptyString(cast.capabilityId) ||
        !isNonEmptyString(cast.taskRunId) ||
        !isNonEmptyString(cast.scriptName)
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "capabilityId, taskRunId, scriptName must be non-empty strings",
          ),
        );
      }
      try {
        const approval = await service.proposeScriptRun({
          capabilityId: cast.capabilityId,
          taskRunId: cast.taskRunId,
          scriptName: cast.scriptName,
        });
        events?.taskRunChanged(approval.taskRunId);
        return ok(approval);
      } catch (e) {
        return wrapErr<Approval>(e, CAPABILITY_REFRESH_FAILED);
      }
    },
  );
};
