import { ipcMain } from "electron";
import {
  ARTIFACT_NOT_FOUND,
  IPC_CHANNELS,
  RUNNER_EXECUTION_FAILED,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type Artifact,
  type ArtifactStore,
  type HarnessResult,
  type RunnerResultPayload,
} from "@harness/core";
import { RunnerError, type RunnerService } from "@harness/runners";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapRunnerErr = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof RunnerError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(RUNNER_EXECUTION_FAILED, msg));
};

export const registerRunnerIpc = (
  runner: RunnerService,
  state: LocalStateService,
  artifactStore: ArtifactStore,
  events: HarnessEventBus,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.runner.executeApproved,
    async (_e, input: unknown): Promise<HarnessResult<RunnerResultPayload>> => {
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
        const result = await runner.executeApproved(cast.approvalId);
        events.taskRunChanged(result.taskRunId);
        return ok(result as RunnerResultPayload);
      } catch (e) {
        return wrapRunnerErr<RunnerResultPayload>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runner.retryApproval,
    async (_e, input: unknown): Promise<HarnessResult<RunnerResultPayload>> => {
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
        const result = await runner.retryApproval(cast.approvalId);
        events.taskRunChanged(result.taskRunId);
        return ok(result as RunnerResultPayload);
      } catch (e) {
        return wrapRunnerErr<RunnerResultPayload>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runner.listArtifacts,
    async (_e, input: unknown): Promise<HarnessResult<Artifact[]>> => {
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
        return ok(await state.listArtifactsByTaskRun(cast.taskRunId));
      } catch (e) {
        return wrapRunnerErr<Artifact[]>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runner.readArtifact,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<{ artifact: Artifact; content: string }>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { artifactId?: unknown };
      if (!isNonEmptyString(cast.artifactId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "artifactId must be non-empty string"),
        );
      }
      try {
        const artifact = await state.artifacts.get(cast.artifactId);
        if (!artifact) {
          return err(
            harnessError(
              ARTIFACT_NOT_FOUND,
              `Artifact ${cast.artifactId} not found`,
            ),
          );
        }
        const content = await artifactStore.read({
          taskRunId: artifact.taskRunId,
          artifactId: artifact.id,
          kind: artifact.kind,
        });
        return ok({ artifact, content });
      } catch (e) {
        return wrapRunnerErr<{ artifact: Artifact; content: string }>(e);
      }
    },
  );
};
