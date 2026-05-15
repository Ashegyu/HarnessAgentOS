import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type EvolutionCandidate,
  type HarnessResult,
  type Instinct,
} from "@harness/core";
import { InstinctService, InstinctServiceError } from "@harness/learner";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof InstinctServiceError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(STATE_INVALID_INPUT, msg));
};

export const registerInstinctIpc = (service: InstinctService): void => {
  ipcMain.handle(
    IPC_CHANNELS.instinct.list,
    async (_e, input: unknown): Promise<HarnessResult<Instinct[]>> => {
      const cast = isObject(input) ? input : {};
      if (cast.projectKey !== undefined && typeof cast.projectKey !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "projectKey must be string"));
      }
      if (
        cast.includeDisabled !== undefined &&
        typeof cast.includeDisabled !== "boolean"
      ) {
        return err(
          harnessError(STATE_INVALID_INPUT, "includeDisabled must be boolean"),
        );
      }
      try {
        const payload: { projectKey?: string; includeDisabled?: boolean } = {};
        if (typeof cast.projectKey === "string" && cast.projectKey.length > 0) {
          payload.projectKey = cast.projectKey;
        }
        if (cast.includeDisabled === true) {
          payload.includeDisabled = true;
        }
        return ok(
          await service.list(payload),
        );
      } catch (e) {
        return wrapErr<Instinct[]>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.instinct.listCandidates,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<EvolutionCandidate[]>> => {
      const cast = isObject(input) ? input : {};
      if (cast.projectKey !== undefined && typeof cast.projectKey !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "projectKey must be string"));
      }
      try {
        const payload: { projectKey?: string } = {};
        if (typeof cast.projectKey === "string" && cast.projectKey.length > 0) {
          payload.projectKey = cast.projectKey;
        }
        return ok(
          await service.listCandidates(payload),
        );
      } catch (e) {
        return wrapErr<EvolutionCandidate[]>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.instinct.approveCandidate,
    async (_e, input: unknown): Promise<HarnessResult<Instinct>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { candidateId?: unknown; message?: unknown };
      if (!isNonEmptyString(cast.candidateId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "candidateId must be non-empty string"),
        );
      }
      try {
        const payload: { candidateId: string; message?: string } = {
          candidateId: cast.candidateId,
        };
        if (typeof cast.message === "string") payload.message = cast.message;
        return ok(await service.approveCandidate(payload));
      } catch (e) {
        return wrapErr<Instinct>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.instinct.rejectCandidate,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<EvolutionCandidate>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { candidateId?: unknown; message?: unknown };
      if (!isNonEmptyString(cast.candidateId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "candidateId must be non-empty string"),
        );
      }
      if (!isNonEmptyString(cast.message)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "message must be non-empty string"),
        );
      }
      try {
        return ok(
          await service.rejectCandidate({
            candidateId: cast.candidateId,
            message: cast.message,
          }),
        );
      } catch (e) {
        return wrapErr<EvolutionCandidate>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.instinct.disable,
    async (_e, input: unknown): Promise<HarnessResult<Instinct>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { instinctId?: unknown; reason?: unknown };
      if (!isNonEmptyString(cast.instinctId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "instinctId must be non-empty string"),
        );
      }
      if (!isNonEmptyString(cast.reason)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "reason must be non-empty string"),
        );
      }
      try {
        return ok(
          await service.disable({
            instinctId: cast.instinctId,
            reason: cast.reason,
          }),
        );
      } catch (e) {
        return wrapErr<Instinct>(e);
      }
    },
  );
};
