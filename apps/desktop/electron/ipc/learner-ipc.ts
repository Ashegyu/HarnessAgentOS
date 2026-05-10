import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  LEARNER_TASK_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type LearnerRecommendation,
  type LearningTrace,
} from "@harness/core";
import { LearnerAdvisor, TraceRecorder } from "@harness/learner";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown, code = LEARNER_TASK_NOT_FOUND): HarnessResult<T> => {
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(code, msg));
};

export const registerLearnerIpc = (
  advisor: LearnerAdvisor,
  recorder: TraceRecorder,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.learner.getTrace,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<LearningTrace | null>> => {
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
        return ok(await advisor.getTrace({ taskRunId: cast.taskRunId }));
      } catch (e) {
        return wrapErr<LearningTrace | null>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.recommend,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<LearnerRecommendation>> => {
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
        return ok(await advisor.recommend({ taskRunId: cast.taskRunId }));
      } catch (e) {
        return wrapErr<LearnerRecommendation>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.recordSelection,
    async (_e, input: unknown): Promise<HarnessResult<LearningTrace>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        selectedModel?: unknown;
        selectedCapabilities?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      const payload: Parameters<typeof recorder.recordSelection>[0] = {
        taskRunId: cast.taskRunId,
      };
      if (typeof cast.selectedModel === "string")
        payload.selectedModel = cast.selectedModel;
      if (Array.isArray(cast.selectedCapabilities)) {
        payload.selectedCapabilities = cast.selectedCapabilities.filter(
          (v): v is string => typeof v === "string",
        );
      }
      try {
        return ok(await recorder.recordSelection(payload));
      } catch (e) {
        return wrapErr<LearningTrace>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.recordOutcome,
    async (_e, input: unknown): Promise<HarnessResult<LearningTrace>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        latencyMs?: unknown;
        costEstimate?: unknown;
        success?: unknown;
        failureReason?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      const payload: Parameters<typeof recorder.recordOutcome>[0] = {
        taskRunId: cast.taskRunId,
      };
      if (typeof cast.latencyMs === "number")
        payload.latencyMs = cast.latencyMs;
      if (typeof cast.costEstimate === "number")
        payload.costEstimate = cast.costEstimate;
      if (typeof cast.success === "boolean") payload.success = cast.success;
      if (typeof cast.failureReason === "string")
        payload.failureReason = cast.failureReason;
      try {
        return ok(await recorder.recordOutcome(payload));
      } catch (e) {
        return wrapErr<LearningTrace>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.recordDecision,
    async (_e, input: unknown): Promise<HarnessResult<null>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        recommendationId?: unknown;
        decision?: unknown;
        reason?: unknown;
      };
      if (
        !isNonEmptyString(cast.taskRunId) ||
        !isNonEmptyString(cast.recommendationId) ||
        (cast.decision !== "accepted" && cast.decision !== "rejected")
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "taskRunId/recommendationId/decision required",
          ),
        );
      }
      const payload: Parameters<typeof advisor.recordDecision>[0] = {
        taskRunId: cast.taskRunId,
        recommendationId: cast.recommendationId,
        decision: cast.decision,
      };
      if (typeof cast.reason === "string") payload.reason = cast.reason;
      try {
        await advisor.recordDecision(payload);
        return ok(null);
      } catch (e) {
        return wrapErr<null>(e);
      }
    },
  );
};
