import { ipcMain } from "electron";
import {
  ARTIFACT_NOT_FOUND,
  IPC_CHANNELS,
  RUNNER_EXECUTION_FAILED,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type CodeChangeAttemptResult,
  type CodeChangeLoopRunInput,
  type Artifact,
  type ArtifactStore,
  type HarnessResult,
  type RunnerCancelExecutionResult,
  type RunnerResultPayload,
} from "@harness/core";
import { RunnerError, type RunnerService } from "@harness/runners";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isNonEmptyString);

export interface RunnerIpcHooks {
  executeApprovedOverride?: (input: {
    approvalId: string;
  }) => Promise<RunnerResultPayload | null>;
  afterExecuteApproved?: (input: {
    approvalId: string;
    result: RunnerResultPayload;
  }) => Promise<void>;
  executeCodeChangeAttempt?: (
    input: CodeChangeLoopRunInput,
  ) => Promise<CodeChangeAttemptResult>;
}

const wrapRunnerErr = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof RunnerError) {
    return err(harnessError(e.code, e.message));
  }
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string"
  ) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError((e as { code: string }).code, msg));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(RUNNER_EXECUTION_FAILED, msg));
};

export const registerRunnerIpc = (
  runner: RunnerService,
  state: LocalStateService,
  artifactStore: ArtifactStore,
  events: HarnessEventBus,
  hooks: RunnerIpcHooks = {},
): void => {
  const emitApprovalTaskRunChanged = async (approvalId: string): Promise<void> => {
    try {
      const approval = await state.getApproval(approvalId);
      if (approval) events.taskRunChanged(approval.taskRunId);
    } catch {
      // Preserve the original runner error result; event emission is best-effort.
    }
  };

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
        const override = await hooks.executeApprovedOverride?.({
          approvalId: cast.approvalId,
        });
        const result =
          override ?? (await runner.executeApproved(cast.approvalId));
        await runAfterExecuteHook(hooks, cast.approvalId, result as RunnerResultPayload);
        events.taskRunChanged(result.taskRunId);
        return ok(result as RunnerResultPayload);
      } catch (e) {
        await emitApprovalTaskRunChanged(cast.approvalId);
        return wrapRunnerErr<RunnerResultPayload>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runner.executeCodeChangeAttempt,
    async (_e, input: unknown): Promise<HarnessResult<CodeChangeAttemptResult>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        changeApprovalIds?: unknown;
        verificationApprovalIds?: unknown;
        attemptNumber?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (!isStringArray(cast.changeApprovalIds)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "changeApprovalIds must be an array of non-empty strings",
          ),
        );
      }
      if (
        cast.verificationApprovalIds !== undefined &&
        !isStringArray(cast.verificationApprovalIds)
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "verificationApprovalIds must be an array of non-empty strings",
          ),
        );
      }
      if (
        cast.attemptNumber !== undefined &&
        (typeof cast.attemptNumber !== "number" ||
          !Number.isInteger(cast.attemptNumber) ||
          cast.attemptNumber < 1)
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "attemptNumber must be a positive integer",
          ),
        );
      }
      if (!hooks.executeCodeChangeAttempt) {
        return err(
          harnessError(
            RUNNER_EXECUTION_FAILED,
            "Code change loop service is not configured",
          ),
        );
      }
      try {
        const attemptNumber =
          typeof cast.attemptNumber === "number" ? cast.attemptNumber : undefined;
        const payload: CodeChangeLoopRunInput = {
          taskRunId: cast.taskRunId,
          changeApprovalIds: cast.changeApprovalIds,
          ...(cast.verificationApprovalIds !== undefined
            ? { verificationApprovalIds: cast.verificationApprovalIds }
            : {}),
          ...(attemptNumber !== undefined ? { attemptNumber } : {}),
        };
        const result = await hooks.executeCodeChangeAttempt(payload);
        events.taskRunChanged(result.taskRunId);
        return ok(result);
      } catch (e) {
        if (isNonEmptyString(cast.taskRunId)) events.taskRunChanged(cast.taskRunId);
        return wrapRunnerErr<CodeChangeAttemptResult>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runner.cancelExecution,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<RunnerCancelExecutionResult>> => {
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
        const result = await runner.cancelExecution({ taskRunId: cast.taskRunId });
        if (result.cancelled) events.taskRunChanged(cast.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapRunnerErr<RunnerCancelExecutionResult>(e);
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
        await runAfterExecuteHook(hooks, cast.approvalId, result as RunnerResultPayload);
        events.taskRunChanged(result.taskRunId);
        return ok(result as RunnerResultPayload);
      } catch (e) {
        await emitApprovalTaskRunChanged(cast.approvalId);
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
        // Only artifacts written through artifactStore.write have a real
        // disk file — those use the canonical `artifact://` URI scheme via
        // buildArtifactUri. Plan/log/quality_report rows created directly
        // through state.createArtifact (e.g. agent-planning-service,
        // conversation-service, orchestration-planner) use a placeholder
        // `harness:*` URI and keep their full content in the `summary`
        // column. Reading these from disk would always ENOENT.
        const onDisk = artifact.uri.startsWith("artifact://");
        if (!onDisk) {
          return ok({ artifact, content: artifact.summary ?? "" });
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

const runAfterExecuteHook = async (
  hooks: RunnerIpcHooks,
  approvalId: string,
  result: RunnerResultPayload,
): Promise<void> => {
  try {
    await hooks.afterExecuteApproved?.({ approvalId, result });
  } catch {
    // Runner execution already succeeded. Follow-up refresh hooks are
    // best-effort and must not turn a valid approval execution into failure.
  }
};
