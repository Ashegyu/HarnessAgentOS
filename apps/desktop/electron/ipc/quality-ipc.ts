import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  QUALITY_DONE_BLOCKED,
  STATE_INVALID_INPUT,
  TaskRunCompletionError,
  TaskRunCompletionService,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type QualityGateInput,
  type QualityGateResult,
  type RepairPlanDraft,
  type TaskRun,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import type { InstinctService } from "@harness/learner";
import { QualityEvaluator, type RepairLoopService } from "@harness/quality";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown, fallbackCode: string): HarnessResult<T> => {
  if (e instanceof TaskRunCompletionError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(fallbackCode, msg));
};

const observeQualityGate = async (
  instinctService: InstinctService | undefined,
  result: QualityGateResult,
): Promise<void> => {
  if (!instinctService) return;
  try {
    await instinctService.recordQualityGate(result);
  } catch {
    // Background learning must never block the quality-gate state change.
  }
};

export const registerQualityIpc = (
  state: LocalStateService,
  evaluator: QualityEvaluator,
  completion: TaskRunCompletionService,
  repairLoop: RepairLoopService,
  events: HarnessEventBus,
  instinctService?: InstinctService,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.quality.evaluate,
    async (_e, input: unknown): Promise<HarnessResult<QualityGateResult>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        requireBuild?: unknown;
        requireTests?: unknown;
        requireSmoke?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      const evaluatorInput: QualityGateInput = { taskRunId: cast.taskRunId };
      if (typeof cast.requireBuild === "boolean")
        evaluatorInput.requireBuild = cast.requireBuild;
      if (typeof cast.requireTests === "boolean")
        evaluatorInput.requireTests = cast.requireTests;
      if (typeof cast.requireSmoke === "boolean")
        evaluatorInput.requireSmoke = cast.requireSmoke;

      try {
        const result = await evaluator.evaluate(evaluatorInput);
        // Reflect the result into TaskRun status (passed/warning -> ready_for_review,
        // failed -> quality_failed). not_run is a no-op.
        await completion.applyQualityGateResult(result);
        await observeQualityGate(instinctService, result);
        events.taskRunChanged(result.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapErr<QualityGateResult>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.quality.getLatest,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<QualityGateResult | null>> => {
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
        const latest = await state.getLatestQualityGateResult(cast.taskRunId);
        return ok(latest);
      } catch (e) {
        return wrapErr<QualityGateResult | null>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.quality.approveKnownRisks,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; message?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (typeof cast.message !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "message must be a string"),
        );
      }
      try {
        const updated = await completion.approveKnownRisks({
          taskRunId: cast.taskRunId,
          message: cast.message,
        });
        events.taskRunChanged(updated.id);
        return ok(updated);
      } catch (e) {
        return wrapErr<TaskRun>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.quality.createRepairPlan,
    async (_e, input: unknown): Promise<HarnessResult<RepairPlanDraft>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; instruction?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      const payload: { taskRunId: string; instruction?: string } = {
        taskRunId: cast.taskRunId,
      };
      if (typeof cast.instruction === "string")
        payload.instruction = cast.instruction;
      try {
        const draft = await repairLoop.createRepairPlan(payload);
        events.taskRunChanged(draft.taskRun.id);
        return ok(draft);
      } catch (e) {
        return wrapErr<RepairPlanDraft>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.quality.markReadyForReview,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
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
        const updated = await completion.markReadyForReview({
          taskRunId: cast.taskRunId,
        });
        events.taskRunChanged(updated.id);
        return ok(updated);
      } catch (e) {
        return wrapErr<TaskRun>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.quality.markDone,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
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
        const updated = await completion.markDone({
          taskRunId: cast.taskRunId,
        });
        events.taskRunChanged(updated.id);
        return ok(updated);
      } catch (e) {
        return wrapErr<TaskRun>(e, QUALITY_DONE_BLOCKED);
      }
    },
  );
};
