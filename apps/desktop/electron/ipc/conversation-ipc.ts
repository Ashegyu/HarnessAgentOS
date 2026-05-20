import { ipcMain } from "electron";
import {
  AUTO_APPROVE_STEPS,
  APPROVAL_ACTION_TYPES,
  APPROVAL_MESSAGE_REQUIRED,
  APPROVAL_NOT_FOUND,
  CONVERSATION_EMPTY_REQUEST,
  CONVERSATION_INVALID_TARGET_DIR,
  CONVERSATION_TASK_NOT_FOUND,
  ConversationServiceError,
  IPC_CHANNELS,
  STATE_DB_ERROR,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  validateProposedActionDetails,
  type Approval,
  type A2ARefinementActivityInput,
  type A2ARefinementActivityPage,
  type AutoApproveDecision,
  type AutoApproveStep,
  type ApproveInput,
  type ConversationService,
  type ConversationTaskDraft,
  type CreateConversationTaskInput,
  type DecisionLogFilter,
  type DecisionLogInput,
  type DecisionLogPage,
  type HarnessResult,
  type PipelineBackflowActivityInput,
  type PipelineBackflowActivityPage,
  type RedirectTaskInput,
  type RejectApprovalInput,
  type TaskRun,
  type TaskRunDetail,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import type { InstinctService } from "@harness/learner";
import type { HarnessEventBus } from "../event-bus";
import { deriveA2ARefinementProposals } from "../a2a-refinement-proposals";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isAutoApproveStep = (
  v: unknown,
): v is AutoApproveDecision["decidedAt"] =>
  typeof v === "string" &&
  (AUTO_APPROVE_STEPS as readonly string[]).includes(v);

const parseAutoApproveDecision = (
  value: unknown,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: AutoApproveDecision | null }
  | { ok: false; reason: string } => {
  if (value === undefined) return { ok: true, present: false };
  if (value === null) return { ok: true, present: true, value: null };
  if (!isObject(value)) {
    return { ok: false, reason: "autoApproveDecision must be an object or null" };
  }
  if (typeof value.approved !== "boolean") {
    return { ok: false, reason: "autoApproveDecision.approved must be boolean" };
  }
  if (!isAutoApproveStep(value.decidedAt)) {
    return { ok: false, reason: "autoApproveDecision.decidedAt is invalid" };
  }
  if (!isNonEmptyString(value.reason)) {
    return { ok: false, reason: "autoApproveDecision.reason must be non-empty" };
  }
  return {
    ok: true,
    present: true,
    value: {
      approved: value.approved,
      decidedAt: value.decidedAt,
      reason: value.reason,
    },
  };
};

const isApprovalActionType = (value: unknown): boolean =>
  typeof value === "string" &&
  (APPROVAL_ACTION_TYPES as readonly string[]).includes(value);

const parseDecisionLogInput = (
  input: unknown,
):
  | { ok: true; value: DecisionLogInput }
  | { ok: false; reason: string } => {
  if (!isObject(input)) {
    return { ok: false, reason: "input must be an object" };
  }
  const cast = input as {
    limit?: unknown;
    offset?: unknown;
    filter?: unknown;
  };
  if (
    typeof cast.limit !== "number" ||
    !Number.isInteger(cast.limit) ||
    cast.limit < 1 ||
    cast.limit > 100
  ) {
    return { ok: false, reason: "limit must be an integer from 1 to 100" };
  }
  if (
    typeof cast.offset !== "number" ||
    !Number.isInteger(cast.offset) ||
    cast.offset < 0
  ) {
    return { ok: false, reason: "offset must be a non-negative integer" };
  }
  const limit = cast.limit;
  const offset = cast.offset;
  if (cast.filter === undefined) {
    return {
      ok: true,
      value: { limit, offset },
    };
  }
  if (!isObject(cast.filter)) {
    return { ok: false, reason: "filter must be an object when provided" };
  }
  const filterInput = cast.filter as {
    decidedAtSteps?: unknown;
    actionTypes?: unknown;
    sinceIso?: unknown;
    untilIso?: unknown;
  };
  const filter: DecisionLogFilter = {};
  if (filterInput.decidedAtSteps !== undefined) {
    if (
      !Array.isArray(filterInput.decidedAtSteps) ||
      !filterInput.decidedAtSteps.every(isAutoApproveStep)
    ) {
      return { ok: false, reason: "filter.decidedAtSteps is invalid" };
    }
    filter.decidedAtSteps = [...new Set(filterInput.decidedAtSteps)] as AutoApproveStep[];
  }
  if (filterInput.actionTypes !== undefined) {
    if (
      !Array.isArray(filterInput.actionTypes) ||
      !filterInput.actionTypes.every(isApprovalActionType)
    ) {
      return { ok: false, reason: "filter.actionTypes is invalid" };
    }
    filter.actionTypes = [...new Set(filterInput.actionTypes)] as DecisionLogFilter["actionTypes"];
  }
  if (filterInput.sinceIso !== undefined) {
    if (!isNonEmptyString(filterInput.sinceIso)) {
      return { ok: false, reason: "filter.sinceIso must be a non-empty string" };
    }
    filter.sinceIso = filterInput.sinceIso;
  }
  if (filterInput.untilIso !== undefined) {
    if (!isNonEmptyString(filterInput.untilIso)) {
      return { ok: false, reason: "filter.untilIso must be a non-empty string" };
    }
    filter.untilIso = filterInput.untilIso;
  }
  return {
    ok: true,
    value: { limit, offset, filter },
  };
};

const parseA2ARefinementActivityInput = (
  input: unknown,
):
  | { ok: true; value: A2ARefinementActivityInput }
  | { ok: false; reason: string } => {
  if (!isObject(input)) {
    return { ok: false, reason: "input must be an object" };
  }
  const cast = input as {
    limit?: unknown;
    offset?: unknown;
    sinceIso?: unknown;
    untilIso?: unknown;
  };
  if (
    typeof cast.limit !== "number" ||
    !Number.isInteger(cast.limit) ||
    cast.limit < 1 ||
    cast.limit > 100
  ) {
    return { ok: false, reason: "limit must be an integer from 1 to 100" };
  }
  if (
    typeof cast.offset !== "number" ||
    !Number.isInteger(cast.offset) ||
    cast.offset < 0
  ) {
    return { ok: false, reason: "offset must be a non-negative integer" };
  }
  const value: A2ARefinementActivityInput = {
    limit: cast.limit,
    offset: cast.offset,
  };
  if (cast.sinceIso !== undefined) {
    if (!isNonEmptyString(cast.sinceIso)) {
      return { ok: false, reason: "sinceIso must be a non-empty string" };
    }
    value.sinceIso = cast.sinceIso;
  }
  if (cast.untilIso !== undefined) {
    if (!isNonEmptyString(cast.untilIso)) {
      return { ok: false, reason: "untilIso must be a non-empty string" };
    }
    value.untilIso = cast.untilIso;
  }
  return { ok: true, value };
};

const parsePipelineBackflowActivityInput = (
  input: unknown,
):
  | { ok: true; value: PipelineBackflowActivityInput }
  | { ok: false; reason: string } => {
  if (!isObject(input)) {
    return { ok: false, reason: "input must be an object" };
  }
  const cast = input as {
    limit?: unknown;
    offset?: unknown;
    sinceIso?: unknown;
    untilIso?: unknown;
  };
  if (
    typeof cast.limit !== "number" ||
    !Number.isInteger(cast.limit) ||
    cast.limit < 1 ||
    cast.limit > 100
  ) {
    return { ok: false, reason: "limit must be an integer from 1 to 100" };
  }
  if (
    typeof cast.offset !== "number" ||
    !Number.isInteger(cast.offset) ||
    cast.offset < 0
  ) {
    return { ok: false, reason: "offset must be a non-negative integer" };
  }
  const value: PipelineBackflowActivityInput = {
    limit: cast.limit,
    offset: cast.offset,
  };
  if (cast.sinceIso !== undefined) {
    if (!isNonEmptyString(cast.sinceIso)) {
      return { ok: false, reason: "sinceIso must be a non-empty string" };
    }
    value.sinceIso = cast.sinceIso;
  }
  if (cast.untilIso !== undefined) {
    if (!isNonEmptyString(cast.untilIso)) {
      return { ok: false, reason: "untilIso must be a non-empty string" };
    }
    value.untilIso = cast.untilIso;
  }
  return { ok: true, value };
};

const mapServiceError = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof ConversationServiceError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(STATE_DB_ERROR, "Conversation service error", msg));
};

const observeApprovalDecision = async (
  instinctService: InstinctService | undefined,
  approval: Approval,
): Promise<void> => {
  if (!instinctService) return;
  try {
    await instinctService.recordApprovalDecision(approval);
  } catch {
    // Instinct observation is advisory state. Approval decisions must not
    // fail because the background observer could not record a signal.
  }
};

export const registerConversationIpc = (
  conversation: ConversationService,
  state: LocalStateService,
  events: HarnessEventBus,
  instinctService?: InstinctService,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.conversation.createTask,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<ConversationTaskDraft>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        threadId?: unknown;
        userRequest?: unknown;
        targetDir?: unknown;
        mode?: unknown;
      };
      if (!isNonEmptyString(cast.userRequest)) {
        return err(
          harnessError(
            CONVERSATION_EMPTY_REQUEST,
            "userRequest must be a non-empty string",
          ),
        );
      }
      if (cast.threadId !== undefined && typeof cast.threadId !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "threadId must be string when provided"),
        );
      }
      if (cast.targetDir !== undefined && typeof cast.targetDir !== "string") {
        return err(
          harnessError(
            CONVERSATION_INVALID_TARGET_DIR,
            "targetDir must be a string when provided",
          ),
        );
      }
      if (
        cast.mode !== undefined &&
        cast.mode !== "template" &&
        cast.mode !== "agent"
      ) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "mode must be 'template' or 'agent' when provided",
          ),
        );
      }
      const payload: CreateConversationTaskInput = {
        userRequest: cast.userRequest,
      };
      if (typeof cast.threadId === "string") payload.threadId = cast.threadId;
      if (typeof cast.targetDir === "string") payload.targetDir = cast.targetDir;
      if (cast.mode === "template" || cast.mode === "agent")
        payload.mode = cast.mode;
      try {
        const draft = await conversation.createTask(payload);
        events.taskRunChanged(draft.taskRun.id);
        return ok(draft);
      } catch (e) {
        return mapServiceError<ConversationTaskDraft>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.redirectTask,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<ConversationTaskDraft>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; instruction?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      if (!isNonEmptyString(cast.instruction)) {
        return err(
          harnessError(
            CONVERSATION_EMPTY_REQUEST,
            "instruction must be a non-empty string",
          ),
        );
      }
      const payload: RedirectTaskInput = {
        taskRunId: cast.taskRunId,
        instruction: cast.instruction,
      };
      try {
        const draft = await conversation.redirectTask(payload);
        events.taskRunChanged(draft.taskRun.id);
        return ok(draft);
      } catch (e) {
        return mapServiceError<ConversationTaskDraft>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.approve,
    async (_e, input: unknown): Promise<HarnessResult<Approval>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        approvalId?: unknown;
        message?: unknown;
        scope?: unknown;
        autoApproveDecision?: unknown;
      };
      if (!isNonEmptyString(cast.approvalId)) {
        return err(
          harnessError(APPROVAL_NOT_FOUND, "approvalId must be a non-empty string"),
        );
      }
      const payload: ApproveInput = { approvalId: cast.approvalId };
      if (typeof cast.message === "string") payload.message = cast.message;
      if (cast.scope === "once" || cast.scope === "run_action_class") {
        payload.scope = cast.scope;
      }
      const parsedDecision = parseAutoApproveDecision(cast.autoApproveDecision);
      if (!parsedDecision.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsedDecision.reason));
      }
      if (parsedDecision.present) {
        payload.autoApproveDecision = parsedDecision.value;
      }
      try {
        const approval = await conversation.approve(payload);
        await observeApprovalDecision(instinctService, approval);
        events.taskRunChanged(approval.taskRunId);
        return ok(approval);
      } catch (e) {
        return mapServiceError<Approval>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.rejectApproval,
    async (_e, input: unknown): Promise<HarnessResult<Approval>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { approvalId?: unknown; message?: unknown };
      if (!isNonEmptyString(cast.approvalId)) {
        return err(
          harnessError(APPROVAL_NOT_FOUND, "approvalId must be a non-empty string"),
        );
      }
      if (!isNonEmptyString(cast.message)) {
        return err(
          harnessError(
            APPROVAL_MESSAGE_REQUIRED,
            "Reject reason message is required",
          ),
        );
      }
      const payload: RejectApprovalInput = {
        approvalId: cast.approvalId,
        message: cast.message,
      };
      try {
        const approval = await conversation.rejectApproval(payload);
        await observeApprovalDecision(instinctService, approval);
        events.taskRunChanged(approval.taskRunId);
        return ok(approval);
      } catch (e) {
        return mapServiceError<Approval>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.setProposedAction,
    async (_e, input: unknown): Promise<HarnessResult<Approval>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { approvalId?: unknown; details?: unknown };
      if (!isNonEmptyString(cast.approvalId)) {
        return err(
          harnessError(APPROVAL_NOT_FOUND, "approvalId must be a non-empty string"),
        );
      }
      if (!isObject(cast.details)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "details must be an object"),
        );
      }
      // Schema validation for renderer-supplied details runs here at
      // the IPC boundary so service/runner trust the normalized payload.
      const approval = await state.getApproval(cast.approvalId);
      if (!approval) {
        return err(
          harnessError(APPROVAL_NOT_FOUND, `Approval ${cast.approvalId} not found`),
        );
      }
      const validation = validateProposedActionDetails(
        cast.details,
        approval.actionType,
      );
      if (!validation.ok || !validation.details) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            validation.reason ?? "Invalid proposedAction details",
          ),
        );
      }
      try {
        const updated = await conversation.setProposedAction(
          cast.approvalId,
          validation.details,
        );
        events.taskRunChanged(updated.taskRunId);
        return ok(updated);
      } catch (e) {
        return mapServiceError<Approval>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.getTaskRunDetail,
    async (_e, input: unknown): Promise<HarnessResult<TaskRunDetail>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      try {
        const taskRun = await state.getTaskRun(cast.taskRunId);
        if (!taskRun) {
          return err(
            harnessError(
              CONVERSATION_TASK_NOT_FOUND,
              `TaskRun ${cast.taskRunId} not found`,
            ),
          );
        }
        const usageIsoDate = new Date().toISOString().slice(0, 10);
        const settings = await state.getSettings();
        const [
          steps,
          approvals,
          artifacts,
          checkpoints,
          qualityGates,
          repairAttempts,
          agentInvocations,
          pipelineBackflowAttempts,
          accumulatedTaskRunCostUsd,
          dailyAgentInvocationCostRows,
        ] =
          await Promise.all([
            state.listStepsByTaskRun(cast.taskRunId),
            state.listApprovalsByTaskRun(cast.taskRunId),
            state.listArtifactsByTaskRun(cast.taskRunId),
            state.listCheckpointsByTaskRun(cast.taskRunId),
            state.listQualityGateResults(cast.taskRunId),
            state.repairAttempts.listByTaskRun(cast.taskRunId),
            state.listAgentInvocationsByTaskRun(cast.taskRunId),
            state.pipelineBackflows.listByTaskRun(cast.taskRunId),
            state.sumAgentInvocationCostByTaskRun(cast.taskRunId),
            state.aggregateAgentInvocationCostByProfileAndDay({
              sinceIso: `${usageIsoDate}T00:00:00.000Z`,
              untilIso: `${usageIsoDate}T23:59:59.999Z`,
              ...(settings.activeAgentProfileId
                ? { profileId: settings.activeAgentProfileId }
                : {}),
            }),
          ]);
        const accumulatedDailyCostUsd = dailyAgentInvocationCostRows.reduce(
          (sum, row) => sum + row.totalCostUsd,
          0,
        );
        const accumulatedTaskRunTokens = agentInvocations.reduce(
          (sum, invocation) => sum + (invocation.totalTokens ?? 0),
          0,
        );
        const accumulatedDailyTokens = dailyAgentInvocationCostRows.reduce(
          (sum, row) => sum + (row.totalTokens ?? 0),
          0,
        );
        const unknownTaskRunCostInvocationCount = agentInvocations.filter(
          (invocation) => invocation.costEstimate === undefined,
        ).length;
        const unknownTaskRunTokenInvocationCount = agentInvocations.filter(
          (invocation) => invocation.totalTokens === undefined,
        ).length;
        const unknownDailyCostInvocationCount =
          dailyAgentInvocationCostRows.reduce(
            (sum, row) => sum + (row.unknownCostInvocationCount ?? 0),
            0,
          );
        const unknownDailyTokenInvocationCount =
          dailyAgentInvocationCostRows.reduce(
            (sum, row) =>
              sum +
              (row.unknownTokenInvocationCount ??
                (row.totalTokens === undefined ? row.count : 0)),
            0,
          );
        const a2aRemoteTaskRefs = (
          await Promise.all(
            agentInvocations.map((invocation) =>
              state.a2aRemoteAgents.getRemoteTaskRef(invocation.id),
            ),
          )
        ).filter((ref) => ref !== null);
        const a2aRefinementAttempts =
          await state.a2aRefinements.listByTaskRun(taskRun.id);
        const a2aRefinementProposals = deriveA2ARefinementProposals({
          taskRun,
          steps,
          artifacts,
          qualityGates,
          agentInvocations,
          a2aRemoteTaskRefs,
          a2aRefinementAttempts,
          a2aEndpoints: await state.a2aRemoteAgents.listEndpoints(),
        });
        return ok({
          taskRun,
          steps,
          approvals,
          artifacts,
          checkpoints,
          qualityGates,
          repairAttempts,
          agentInvocations,
          a2aRemoteTaskRefs,
          a2aRefinementAttempts,
          pipelineBackflowAttempts,
          a2aRefinementProposals,
          budgetUsage: {
            accumulatedTaskRunCostUsd,
            accumulatedDailyCostUsd,
            accumulatedTaskRunTokens,
            accumulatedDailyTokens,
            ...(unknownTaskRunCostInvocationCount > 0
              ? { unknownTaskRunCostInvocationCount }
              : {}),
            ...(unknownDailyCostInvocationCount > 0
              ? { unknownDailyCostInvocationCount }
              : {}),
            ...(unknownTaskRunTokenInvocationCount > 0
              ? { unknownTaskRunTokenInvocationCount }
              : {}),
            ...(unknownDailyTokenInvocationCount > 0
              ? { unknownDailyTokenInvocationCount }
              : {}),
            isoDate: usageIsoDate,
          },
        });
      } catch (e) {
        return mapServiceError<TaskRunDetail>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.listDecisions,
    async (_e, input: unknown): Promise<HarnessResult<DecisionLogPage>> => {
      const parsed = parseDecisionLogInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      try {
        return ok(await state.listDecisions(parsed.value));
      } catch (e) {
        return mapServiceError<DecisionLogPage>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.listRefinementEvents,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<A2ARefinementActivityPage>> => {
      const parsed = parseA2ARefinementActivityInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      try {
        return ok(await state.a2aRefinements.listActivityEvents(parsed.value));
      } catch (e) {
        return mapServiceError<A2ARefinementActivityPage>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.listBackflowEvents,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<PipelineBackflowActivityPage>> => {
      const parsed = parsePipelineBackflowActivityInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      try {
        return ok(await state.pipelineBackflows.listActivityEvents(parsed.value));
      } catch (e) {
        return mapServiceError<PipelineBackflowActivityPage>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.pauseTask,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      try {
        const tr = await conversation.pauseTask({ taskRunId: cast.taskRunId });
        events.taskRunChanged(tr.id);
        return ok(tr);
      } catch (e) {
        return mapServiceError<TaskRun>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.resumeTask,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      try {
        const tr = await conversation.resumeTask({ taskRunId: cast.taskRunId });
        events.taskRunChanged(tr.id);
        return ok(tr);
      } catch (e) {
        return mapServiceError<TaskRun>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.cancelTask,
    async (_e, input: unknown): Promise<HarnessResult<TaskRun>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown; reason?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      if (typeof cast.reason !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "reason must be a string"),
        );
      }
      try {
        const tr = await conversation.cancelTask({
          taskRunId: cast.taskRunId,
          reason: cast.reason,
        });
        events.taskRunChanged(tr.id);
        return ok(tr);
      } catch (e) {
        return mapServiceError<TaskRun>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.conversation.deleteTask,
    async (_e, input: unknown): Promise<HarnessResult<void>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      try {
        await state.deleteTaskRun(cast.taskRunId);
        events.taskRunChanged(cast.taskRunId);
        return ok(undefined);
      } catch (e) {
        return mapServiceError<void>(e);
      }
    },
  );
};
