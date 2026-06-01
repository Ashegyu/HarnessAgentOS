import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  LEARNER_INVALID_DECISION,
  LEARNER_TASK_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type ContextOutcomeSummary,
  type LearnerContextDecisionRecord,
  type LearnerRecommendationApprovalResult,
  type LearnerRecommendation,
  type LearningTrace,
  type Observation,
  type ObservationRecallResult,
  type BudgetUsageSummary,
  type TaskRunCostSummary,
} from "@harness/core";
import {
  LearnerAdvisor,
  LearnerAdvisorError,
  TraceRecorder,
} from "@harness/learner";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const optionalPositiveInteger = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : undefined;

const OBSERVATION_SOURCES = new Set<Observation["source"]>([
  "approval",
  "quality",
  "learner",
  "runner",
  "skill",
  "agent",
]);

const isObservationSource = (v: unknown): v is Observation["source"] =>
  typeof v === "string" &&
  OBSERVATION_SOURCES.has(v as Observation["source"]);

const CONTEXT_DECISION_REUSE_RISKS = new Set(["low", "medium", "high"]);
const CONTEXT_DECISION_SURFACES = new Set(["recommended", "recall"]);

const isContextDecisionReuseRisk = (
  v: unknown,
): v is NonNullable<LearnerContextDecisionRecord["reuseRisk"]> =>
  typeof v === "string" && CONTEXT_DECISION_REUSE_RISKS.has(v);

const isContextDecisionSurface = (
  v: unknown,
): v is NonNullable<LearnerContextDecisionRecord["surface"]> =>
  typeof v === "string" && CONTEXT_DECISION_SURFACES.has(v);

const wrapErr = <T>(e: unknown, code = LEARNER_TASK_NOT_FOUND): HarnessResult<T> => {
  if (e instanceof LearnerAdvisorError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(code, msg));
};

export const registerLearnerIpc = (
  advisor: LearnerAdvisor,
  recorder: TraceRecorder,
  events?: HarnessEventBus,
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
    IPC_CHANNELS.learner.summarizeTaskRunCost,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<TaskRunCostSummary>> => {
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
        return ok(
          await advisor.summarizeTaskRunCost({ taskRunId: cast.taskRunId }),
        );
      } catch (e) {
        return wrapErr<TaskRunCostSummary>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.summarizeBudgetUsage,
    async (_e, input: unknown): Promise<HarnessResult<BudgetUsageSummary>> => {
      if (input !== undefined && !isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = (input ?? {}) as {
        days?: unknown;
        profileId?: unknown;
      };
      if (
        cast.profileId !== undefined &&
        (typeof cast.profileId !== "string" || cast.profileId.trim().length === 0)
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "profileId must be a non-empty string when provided",
          ),
        );
      }
      const days = optionalPositiveInteger(cast.days);
      if (cast.days !== undefined && days === undefined) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "days must be a positive number when provided",
          ),
        );
      }
      try {
        return ok(
          await advisor.summarizeBudgetUsage({
            ...(days !== undefined ? { days } : {}),
            ...(typeof cast.profileId === "string"
              ? { profileId: cast.profileId }
              : {}),
          }),
        );
      } catch (e) {
        return wrapErr<BudgetUsageSummary>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.recallContext,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<ObservationRecallResult[]>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        query?: unknown;
        source?: unknown;
        limit?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      if (cast.query !== undefined && typeof cast.query !== "string") {
        return err(harnessError(STATE_INVALID_INPUT, "query must be a string"));
      }
      if (cast.source !== undefined && !isObservationSource(cast.source)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "source must be a known observation source"),
        );
      }
      const source =
        cast.source !== undefined && isObservationSource(cast.source)
          ? cast.source
          : undefined;
      const limit = optionalPositiveInteger(cast.limit);
      if (cast.limit !== undefined && limit === undefined) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "limit must be a positive number when provided",
          ),
        );
      }
      try {
        return ok(
          await advisor.recallContext({
            taskRunId: cast.taskRunId,
            ...(typeof cast.query === "string" ? { query: cast.query } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      } catch (e) {
        return wrapErr<ObservationRecallResult[]>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.learner.summarizeContextOutcomes,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<ContextOutcomeSummary>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        limit?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
        );
      }
      const limit = optionalPositiveInteger(cast.limit);
      if (cast.limit !== undefined && limit === undefined) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "limit must be a positive number when provided",
          ),
        );
      }
      try {
        return ok(
          await advisor.summarizeContextOutcomes({
            taskRunId: cast.taskRunId,
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      } catch (e) {
        return wrapErr<ContextOutcomeSummary>(e);
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
    IPC_CHANNELS.learner.proposeRecommendation,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<LearnerRecommendationApprovalResult>> => {
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
        const result = await advisor.proposeRecommendationApprovals({
          taskRunId: cast.taskRunId,
        });
        if (result.approvals.length > 0) {
          events?.taskRunChanged(cast.taskRunId);
        }
        return ok(result);
      } catch (e) {
        return wrapErr<LearnerRecommendationApprovalResult>(e);
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
      if (!isNonEmptyString(cast.taskRunId) || !isNonEmptyString(cast.recommendationId)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "taskRunId and recommendationId are required",
          ),
        );
      }
      if (cast.decision !== "accepted" && cast.decision !== "rejected") {
        return err(
          harnessError(
            LEARNER_INVALID_DECISION,
            `decision must be 'accepted' or 'rejected' (got ${String(cast.decision)})`,
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

  ipcMain.handle(
    IPC_CHANNELS.learner.recordContextDecision,
    async (_e, input: unknown): Promise<HarnessResult<null>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        observationId?: unknown;
        decision?: unknown;
        surface?: unknown;
        score?: unknown;
        reuseRisk?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId) || !isNonEmptyString(cast.observationId)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "taskRunId and observationId are required",
          ),
        );
      }
      if (cast.decision !== "pinned" && cast.decision !== "unpinned") {
        return err(
          harnessError(
            LEARNER_INVALID_DECISION,
            "decision must be 'pinned' or 'unpinned'",
          ),
        );
      }
      const payload: LearnerContextDecisionRecord = {
        taskRunId: cast.taskRunId,
        observationId: cast.observationId,
        decision: cast.decision,
      };
      if (isContextDecisionSurface(cast.surface)) payload.surface = cast.surface;
      if (typeof cast.score === "number" && Number.isFinite(cast.score)) {
        payload.score = cast.score;
      }
      if (isContextDecisionReuseRisk(cast.reuseRisk)) {
        payload.reuseRisk = cast.reuseRisk;
      }
      try {
        await advisor.recordContextDecision(payload);
        return ok(null);
      } catch (e) {
        return wrapErr<null>(e);
      }
    },
  );
};
