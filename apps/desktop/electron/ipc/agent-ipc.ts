import { ipcMain } from "electron";
import {
  AGENT_INVOCATION_BUSY,
  AGENT_INVOCATION_NOT_FOUND,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_TASK_RUN_NOT_FOUND,
  CONVERSATION_TASK_NOT_FOUND,
  ConversationService,
  ConversationServiceError,
  IPC_CHANNELS,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type AgentInvocation,
  type AgentProvider,
  type AgentProviderStatusMap,
  type Approval,
  type Artifact,
  type HarnessResult,
} from "@harness/core";
import { AgentPlanningError, AgentPlanningService } from "@harness/agent";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isProvider = (v: unknown): v is AgentProvider =>
  v === "claude" || v === "codex";

const wrapErr = <T>(e: unknown, fallback = AGENT_PROVIDER_UNAVAILABLE): HarnessResult<T> => {
  if (e instanceof AgentPlanningError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(fallback, msg));
};

export interface AgentIpcContext {
  planning: AgentPlanningService;
  conversation: ConversationService;
  state: LocalStateService;
  /** Async probe — called by `agent:checkProviders` and cached upstream. */
  probeProviders: () => Promise<AgentProviderStatusMap>;
}

export const registerAgentIpc = (
  ctx: AgentIpcContext,
  events: HarnessEventBus,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.agent.checkProviders,
    async (): Promise<HarnessResult<AgentProviderStatusMap>> => {
      try {
        return ok(await ctx.probeProviders());
      } catch (e) {
        return wrapErr<AgentProviderStatusMap>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.agent.generatePlan,
    async (
      _e,
      input: unknown,
    ): Promise<
      HarnessResult<{
        invocation: AgentInvocation;
        planArtifact: Artifact;
        approvals: Approval[];
      }>
    > => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        provider?: unknown;
        model?: unknown;
        instruction?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            CONVERSATION_TASK_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      if (cast.provider !== undefined && !isProvider(cast.provider)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "provider must be 'claude' or 'codex'"),
        );
      }
      if (cast.model !== undefined && !isNonEmptyString(cast.model)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "model must be a non-empty string"),
        );
      }
      if (cast.instruction !== undefined && typeof cast.instruction !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "instruction must be a string"),
        );
      }
      const payload: Parameters<typeof ctx.planning.generatePlan>[0] = {
        taskRunId: cast.taskRunId,
      };
      if (isProvider(cast.provider)) payload.provider = cast.provider;
      if (typeof cast.model === "string") payload.model = cast.model;
      if (typeof cast.instruction === "string")
        payload.instruction = cast.instruction;
      try {
        const result = await ctx.planning.generatePlan(payload);
        events.taskRunChanged(result.invocation.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapErr<{
          invocation: AgentInvocation;
          planArtifact: Artifact;
          approvals: Approval[];
        }>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.agent.cancelInvocation,
    async (_e, input: unknown): Promise<HarnessResult<AgentInvocation>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { invocationId?: unknown };
      if (!isNonEmptyString(cast.invocationId)) {
        return err(
          harnessError(
            AGENT_INVOCATION_NOT_FOUND,
            "invocationId must be a non-empty string",
          ),
        );
      }
      try {
        const inv = await ctx.planning.cancelInvocation({
          invocationId: cast.invocationId,
        });
        events.taskRunChanged(inv.taskRunId);
        return ok(inv);
      } catch (e) {
        return wrapErr<AgentInvocation>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.agent.retryInvocation,
    async (
      _e,
      input: unknown,
    ): Promise<
      HarnessResult<{
        invocation: AgentInvocation;
        planArtifact: Artifact;
        approvals: Approval[];
      }>
    > => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { invocationId?: unknown };
      if (!isNonEmptyString(cast.invocationId)) {
        return err(
          harnessError(
            AGENT_INVOCATION_NOT_FOUND,
            "invocationId must be a non-empty string",
          ),
        );
      }
      try {
        const result = await ctx.planning.retryInvocation({
          invocationId: cast.invocationId,
        });
        events.taskRunChanged(result.invocation.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapErr<{
          invocation: AgentInvocation;
          planArtifact: Artifact;
          approvals: Approval[];
        }>(e);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.agent.useTemplateFallback,
    async (
      _e,
      input: unknown,
    ): Promise<HarnessResult<{ planArtifact: Artifact; approvals: Approval[] }>> => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as { taskRunId?: unknown };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(
          harnessError(
            AGENT_TASK_RUN_NOT_FOUND,
            "taskRunId must be a non-empty string",
          ),
        );
      }
      // Refuse if an agent invocation is still queued or running for
      // this TaskRun. The user must cancel first so the ledger doesn't
      // race a parallel approval pile.
      const invocations = await ctx.state.listAgentInvocationsByTaskRun(
        cast.taskRunId,
      );
      const busy = invocations.some(
        (i) => i.status === "queued" || i.status === "running",
      );
      if (busy) {
        return err(
          harnessError(
            AGENT_INVOCATION_BUSY,
            "An agent invocation is still in progress — cancel it before falling back to a template plan.",
          ),
        );
      }
      try {
        const result = await ctx.conversation.useTemplateFallback({
          taskRunId: cast.taskRunId,
        });
        events.taskRunChanged(cast.taskRunId);
        return ok(result);
      } catch (e) {
        if (e instanceof ConversationServiceError) {
          return err(harnessError(e.code, e.message));
        }
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(AGENT_PROVIDER_UNAVAILABLE, msg));
      }
    },
  );
};
