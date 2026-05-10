import { ipcMain } from "electron";
import {
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
  type ApproveInput,
  type ConversationService,
  type ConversationTaskDraft,
  type CreateConversationTaskInput,
  type HarnessResult,
  type RedirectTaskInput,
  type RejectApprovalInput,
  type TaskRun,
  type TaskRunDetail,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const mapServiceError = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof ConversationServiceError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(STATE_DB_ERROR, "Conversation service error", msg));
};

export const registerConversationIpc = (
  conversation: ConversationService,
  state: LocalStateService,
  events: HarnessEventBus,
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
      const payload: CreateConversationTaskInput = {
        userRequest: cast.userRequest,
      };
      if (typeof cast.threadId === "string") payload.threadId = cast.threadId;
      if (typeof cast.targetDir === "string") payload.targetDir = cast.targetDir;
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
      try {
        const approval = await conversation.approve(payload);
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
        const [steps, approvals, artifacts, checkpoints] = await Promise.all([
          state.listStepsByTaskRun(cast.taskRunId),
          state.listApprovalsByTaskRun(cast.taskRunId),
          state.listArtifactsByTaskRun(cast.taskRunId),
          state.listCheckpointsByTaskRun(cast.taskRunId),
        ]);
        return ok({ taskRun, steps, approvals, artifacts, checkpoints });
      } catch (e) {
        return mapServiceError<TaskRunDetail>(e);
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
};
