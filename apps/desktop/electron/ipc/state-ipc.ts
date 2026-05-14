import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  STATE_DB_ERROR,
  STATE_INVALID_INPUT,
  STATE_THREAD_NOT_FOUND,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type Thread,
  type ThreadDetail,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapDbError = (e: unknown): HarnessResult<never> =>
  err(harnessError(STATE_DB_ERROR, "Local state DB error", String(e)));

export const registerStateIpc = (service: LocalStateService): void => {
  ipcMain.handle(
    IPC_CHANNELS.state.listThreads,
    async (): Promise<HarnessResult<Thread[]>> => {
      try {
        return ok(await service.listThreads());
      } catch (e) {
        return wrapDbError(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.state.getThread,
    async (_event, input: unknown): Promise<HarnessResult<ThreadDetail>> => {
      if (
        typeof input !== "object" ||
        input === null ||
        !isNonEmptyString((input as { threadId?: unknown }).threadId)
      ) {
        return err(
          harnessError(STATE_INVALID_INPUT, "threadId must be a non-empty string"),
        );
      }
      const threadId = (input as { threadId: string }).threadId;
      try {
        const detail = await service.getThreadDetail(threadId);
        if (!detail) {
          return err(
            harnessError(STATE_THREAD_NOT_FOUND, `Thread ${threadId} not found`),
          );
        }
        return ok(detail);
      } catch (e) {
        return wrapDbError(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.state.deleteThread,
    async (_event, input: unknown): Promise<HarnessResult<void>> => {
      if (
        typeof input !== "object" ||
        input === null ||
        !isNonEmptyString((input as { threadId?: unknown }).threadId)
      ) {
        return err(
          harnessError(STATE_INVALID_INPUT, "threadId must be a non-empty string"),
        );
      }
      const threadId = (input as { threadId: string }).threadId;
      try {
        await service.deleteThread(threadId);
        return ok(undefined);
      } catch (e) {
        return wrapDbError(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.state.createThread,
    async (_event, input: unknown): Promise<HarnessResult<Thread>> => {
      if (typeof input !== "object" || input === null) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        title?: unknown;
        targetDir?: unknown;
        pipelineId?: unknown;
      };
      if (!isNonEmptyString(cast.title)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "title must be a non-empty string"),
        );
      }
      if (cast.targetDir !== undefined && typeof cast.targetDir !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "targetDir must be a string when provided"),
        );
      }
      if (cast.pipelineId !== undefined && typeof cast.pipelineId !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "pipelineId must be a string when provided"),
        );
      }
      try {
        const payload: {
          title: string;
          targetDir?: string;
          pipelineId?: string;
        } = { title: cast.title };
        if (cast.targetDir !== undefined) payload.targetDir = cast.targetDir;
        if (cast.pipelineId !== undefined && cast.pipelineId.length > 0) {
          payload.pipelineId = cast.pipelineId;
        }
        return ok(await service.createThread(payload));
      } catch (e) {
        // validateTargetDir throws with descriptive message; surface as INVALID_INPUT.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("Invalid targetDir")) {
          return err(harnessError(STATE_INVALID_INPUT, msg));
        }
        return wrapDbError(e);
      }
    },
  );
};
