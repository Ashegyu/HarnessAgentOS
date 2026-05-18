import { ipcMain } from "electron";
import { basename, dirname, isAbsolute } from "node:path";
import {
  IPC_CHANNELS,
  STATE_DB_ERROR,
  STATE_INVALID_INPUT,
  STATE_THREAD_NOT_FOUND,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type ExportApprovalResult,
  type ProposedActionDetails,
  type Thread,
  type ThreadDetail,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapDbError = (e: unknown): HarnessResult<never> =>
  err(harnessError(STATE_DB_ERROR, "Local state DB error", String(e)));

export const registerStateIpc = (
  service: LocalStateService,
  events?: HarnessEventBus,
): void => {
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

  ipcMain.handle(
    IPC_CHANNELS.state.exportDbSnapshot,
    async (_event, input: unknown): Promise<HarnessResult<ExportApprovalResult>> => {
      const parsed = parseTargetPathInput(input);
      if (!parsed.ok) return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      try {
        const targetPath = parsed.targetPath;
        const result = await createExportApproval({
          service,
          targetPath,
          title: `DB snapshot export: ${basename(targetPath)}`,
          actionSummary: `Export SQLite DB snapshot to ${targetPath}`,
          proposedAction: {
            type: "file_write",
            dbSnapshotExport: { targetPath },
          },
        });
        events?.taskRunChanged(result.taskRun.id);
        return ok(result);
      } catch (e) {
        return wrapDbError(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.state.exportThreadMarkdown,
    async (_event, input: unknown): Promise<HarnessResult<ExportApprovalResult>> => {
      const parsed = parseThreadMarkdownInput(input);
      if (!parsed.ok) return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      try {
        const markdown = await service.buildThreadMarkdown(parsed.threadId);
        if (markdown === null) {
          return err(
            harnessError(
              STATE_THREAD_NOT_FOUND,
              `Thread ${parsed.threadId} not found`,
            ),
          );
        }
        const targetPath = parsed.targetPath;
        const result = await createExportApproval({
          service,
          targetPath,
          title: `Thread markdown export: ${basename(targetPath)}`,
          actionSummary: `Export thread ${parsed.threadId} markdown to ${targetPath}`,
          proposedAction: {
            type: "file_write",
            filePatch: {
              path: basename(targetPath),
              after: markdown,
            },
          },
        });
        events?.taskRunChanged(result.taskRun.id);
        return ok(result);
      } catch (e) {
        return wrapDbError(e);
      }
    },
  );
};

const parseTargetPathInput = (
  input: unknown,
):
  | { ok: true; targetPath: string }
  | { ok: false; reason: string } => {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "input must be an object" };
  }
  const targetPath = (input as { targetPath?: unknown }).targetPath;
  if (!isNonEmptyString(targetPath)) {
    return { ok: false, reason: "targetPath must be a non-empty string" };
  }
  if (!isAbsolute(targetPath)) {
    return { ok: false, reason: "targetPath must be absolute" };
  }
  if (basename(targetPath).trim().length === 0) {
    return { ok: false, reason: "targetPath must include a file name" };
  }
  return { ok: true, targetPath };
};

const parseThreadMarkdownInput = (
  input: unknown,
):
  | { ok: true; threadId: string; targetPath: string }
  | { ok: false; reason: string } => {
  const target = parseTargetPathInput(input);
  if (!target.ok) return target;
  const threadId = (input as { threadId?: unknown }).threadId;
  if (!isNonEmptyString(threadId)) {
    return { ok: false, reason: "threadId must be a non-empty string" };
  }
  return { ok: true, threadId, targetPath: target.targetPath };
};

const createExportApproval = async (input: {
  service: LocalStateService;
  targetPath: string;
  title: string;
  actionSummary: string;
  proposedAction: ProposedActionDetails;
}): Promise<ExportApprovalResult> => {
  const targetDir = dirname(input.targetPath);
  const thread = await input.service.createThread({
    title: "Backup / Export",
    targetDir,
  });
  const taskRun = await input.service.createTaskRun({
    threadId: thread.id,
    userRequest: input.title,
    targetDir,
  });
  const step = await input.service.createStep({
    taskRunId: taskRun.id,
    index: 0,
    kind: "approval",
    title: input.title,
    status: "pending",
    inputSummary: input.actionSummary,
  });
  const checkpoint = await input.service.createCheckpoint({
    taskRunId: taskRun.id,
    stepId: step.id,
    reason: "manual",
    stateRef: `harness:export/${taskRun.id}`,
    summary: input.actionSummary,
  });
  await input.service.setTaskRunCurrentStep(taskRun.id, step.id);
  const approval = await input.service.createApproval({
    taskRunId: taskRun.id,
    checkpointId: checkpoint.id,
    actionType: "file_write",
    actionSummary: input.actionSummary,
    proposedAction: input.proposedAction,
  });
  const waiting = await input.service.setTaskRunStatus(
    taskRun.id,
    "waiting_for_approval",
  );
  return {
    thread,
    taskRun: waiting,
    checkpoint,
    approval,
    targetPath: input.targetPath,
  };
};
