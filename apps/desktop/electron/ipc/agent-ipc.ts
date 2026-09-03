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
  type A2ARefinementAttempt,
  type A2ARefinementFeedbackSourceKind,
  type Approval,
  type Artifact,
  type HarnessResult,
  type ObservationRecallOutcome,
  type ObservationRecallResult,
  type ObservationReuseRisk,
} from "@harness/core";
import { AgentPlanningError, AgentPlanningService } from "@harness/agent";
import type { LocalStateService } from "@harness/storage";
import type { HarnessEventBus } from "../event-bus";
import {
  A2ARefinementRequestError,
  requestA2ARefinement,
} from "../a2a-refinement-request";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const isProvider = (v: unknown): v is AgentProvider =>
  v === "codex";

const isFeedbackSourceKind = (
  v: unknown,
): v is A2ARefinementFeedbackSourceKind =>
  v === "user" || v === "quality_gate" || v === "worker" || v === "system";

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const isObservationSource = (
  v: unknown,
): v is ObservationRecallResult["source"] =>
  v === "approval" ||
  v === "quality" ||
  v === "learner" ||
  v === "runner" ||
  v === "skill" ||
  v === "agent";

const isObservationReuseRisk = (v: unknown): v is ObservationReuseRisk =>
  v === "low" || v === "medium" || v === "high";

const isObservationOutcomeStatus = (
  v: unknown,
): v is NonNullable<ObservationRecallOutcome["lastStatus"]> =>
  v === "passed" || v === "warning" || v === "failed";

const isContextOutcomeSource = (
  v: unknown,
): v is NonNullable<ObservationRecallOutcome["lastOutcomeSource"]> =>
  v === "quality" || v === "agent" || v === "runner" || v === "unknown";

const isNonNegativeInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

const validatePinnedObservationOutcome = (
  value: unknown,
): { ok: true; value: ObservationRecallOutcome | null } | { ok: false; reason: string } => {
  if (value === undefined) return { ok: true, value: null };
  if (!isObject(value)) {
    return {
      ok: false,
      reason: "pinnedObservationContexts outcome must be an object",
    };
  }
  if (
    !isNonNegativeInteger(value.usedCount) ||
    !isNonNegativeInteger(value.passedCount) ||
    !isNonNegativeInteger(value.warningCount) ||
    !isNonNegativeInteger(value.failedCount) ||
    !isNonNegativeInteger(value.qualityOutcomeCount) ||
    !isNonNegativeInteger(value.agentOutcomeCount) ||
    !isNonNegativeInteger(value.runnerOutcomeCount) ||
    !isNonNegativeInteger(value.unknownOutcomeCount) ||
    typeof value.scoreAdjustment !== "number" ||
    !Number.isFinite(value.scoreAdjustment) ||
    !isObservationReuseRisk(value.reuseRisk)
  ) {
    return {
      ok: false,
      reason: "pinnedObservationContexts contains an invalid outcome",
    };
  }
  if (
    value.lastStatus !== undefined &&
    !isObservationOutcomeStatus(value.lastStatus)
  ) {
    return {
      ok: false,
      reason: "pinnedObservationContexts contains an invalid outcome status",
    };
  }
  if (
    value.lastOutcomeSource !== undefined &&
    !isContextOutcomeSource(value.lastOutcomeSource)
  ) {
    return {
      ok: false,
      reason: "pinnedObservationContexts contains an invalid outcome source",
    };
  }
  if (value.lastSeenAt !== undefined && typeof value.lastSeenAt !== "string") {
    return {
      ok: false,
      reason: "pinnedObservationContexts contains an invalid outcome timestamp",
    };
  }
  const outcome: ObservationRecallOutcome = {
    usedCount: value.usedCount,
    passedCount: value.passedCount,
    warningCount: value.warningCount,
    failedCount: value.failedCount,
    qualityOutcomeCount: value.qualityOutcomeCount,
    agentOutcomeCount: value.agentOutcomeCount,
    runnerOutcomeCount: value.runnerOutcomeCount,
    unknownOutcomeCount: value.unknownOutcomeCount,
    scoreAdjustment: value.scoreAdjustment,
    reuseRisk: value.reuseRisk,
  };
  if (value.lastStatus !== undefined) {
    outcome.lastStatus = value.lastStatus;
  }
  if (value.lastOutcomeSource !== undefined) {
    outcome.lastOutcomeSource = value.lastOutcomeSource;
  }
  if (typeof value.lastSeenAt === "string") {
    outcome.lastSeenAt = value.lastSeenAt;
  }
  return { ok: true, value: outcome };
};

const validatePinnedObservationContexts = (
  value: unknown,
): { ok: true; value: ObservationRecallResult[] } | { ok: false; reason: string } => {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, reason: "pinnedObservationContexts must be an array" };
  }
  if (value.length > 5) {
    return {
      ok: false,
      reason: "pinnedObservationContexts supports at most 5 items",
    };
  }
  const contexts: ObservationRecallResult[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      return {
        ok: false,
        reason: "pinnedObservationContexts entries must be objects",
      };
    }
    if (
      !isNonEmptyString(item.observationId) ||
      !isObservationSource(item.source) ||
      !isNonEmptyString(item.eventType) ||
      !isNonEmptyString(item.signal) ||
      !isNonEmptyString(item.summary) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score) ||
      !isNonEmptyString(item.createdAt)
    ) {
      return {
        ok: false,
        reason: "pinnedObservationContexts contains an invalid entry",
      };
    }
    if (item.summary.length > 1_000) {
      return {
        ok: false,
        reason: "pinnedObservationContexts summary is too long",
      };
    }
    const outcomeValidation = validatePinnedObservationOutcome(item.outcome);
    if (!outcomeValidation.ok) {
      return { ok: false, reason: outcomeValidation.reason };
    }
    contexts.push({
      observationId: item.observationId,
      ...(typeof item.taskRunId === "string" ? { taskRunId: item.taskRunId } : {}),
      ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
      ...(typeof item.projectKey === "string" ? { projectKey: item.projectKey } : {}),
      source: item.source,
      eventType: item.eventType,
      signal: item.signal,
      summary: item.summary,
      score: item.score,
      createdAt: item.createdAt,
      ...(outcomeValidation.value
        ? { outcome: { ...outcomeValidation.value } }
        : {}),
    });
  }
  return { ok: true, value: contexts };
};

const wrapErr = <T>(
  e: unknown,
  fallback: string = AGENT_PROVIDER_UNAVAILABLE,
): HarnessResult<T> => {
  if (e instanceof AgentPlanningError) {
    return err(harnessError(e.code, e.message));
  }
  if (e instanceof A2ARefinementRequestError) {
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
        pinnedObservationContexts?: unknown;
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
          harnessError(STATE_INVALID_INPUT, "provider must be 'codex'"),
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
      const pinnedValidation = validatePinnedObservationContexts(
        cast.pinnedObservationContexts,
      );
      if (!pinnedValidation.ok) {
        return err(harnessError(STATE_INVALID_INPUT, pinnedValidation.reason));
      }
      const settings = await ctx.state.getSettings();
      const payload: Parameters<typeof ctx.planning.generatePlan>[0] = {
        taskRunId: cast.taskRunId,
        timeoutMs: settings.agent.timeoutMs,
        stallTimeoutMs: settings.agent.stallTimeoutMs,
        pinnedObservationContexts: pinnedValidation.value,
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
      const settings = await ctx.state.getSettings();
      try {
        const result = await ctx.planning.retryInvocation({
          invocationId: cast.invocationId,
          timeoutMs: settings.agent.timeoutMs,
          stallTimeoutMs: settings.agent.stallTimeoutMs,
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

  ipcMain.handle(
    IPC_CHANNELS.agent.requestRefinement,
    async (
      _e,
      input: unknown,
    ): Promise<
      HarnessResult<{ attempt: A2ARefinementAttempt; approval: Approval }>
    > => {
      if (!isObject(input)) {
        return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
      }
      const cast = input as {
        taskRunId?: unknown;
        targetInvocationId?: unknown;
        feedbackSourceKind?: unknown;
        feedbackSourceStepId?: unknown;
        feedbackSourceInvocationId?: unknown;
        feedbackArtifactId?: unknown;
        qualityGateId?: unknown;
        instruction?: unknown;
        referencedArtifactIds?: unknown;
      };
      if (!isNonEmptyString(cast.taskRunId)) {
        return err(harnessError(STATE_INVALID_INPUT, "taskRunId is required"));
      }
      if (!isNonEmptyString(cast.targetInvocationId)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "targetInvocationId is required"),
        );
      }
      if (!isFeedbackSourceKind(cast.feedbackSourceKind)) {
        return err(
          harnessError(STATE_INVALID_INPUT, "feedbackSourceKind is invalid"),
        );
      }
      if (!isNonEmptyString(cast.instruction)) {
        return err(harnessError(STATE_INVALID_INPUT, "instruction is required"));
      }
      if (!isStringArray(cast.referencedArtifactIds)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "referencedArtifactIds must be a string array",
          ),
        );
      }
      try {
        const result = await requestA2ARefinement({
          state: ctx.state,
          input: {
            taskRunId: cast.taskRunId,
            targetInvocationId: cast.targetInvocationId,
            feedbackSourceKind: cast.feedbackSourceKind,
            instruction: cast.instruction,
            referencedArtifactIds: cast.referencedArtifactIds,
            ...(isNonEmptyString(cast.feedbackSourceStepId)
              ? { feedbackSourceStepId: cast.feedbackSourceStepId }
              : {}),
            ...(isNonEmptyString(cast.feedbackSourceInvocationId)
              ? { feedbackSourceInvocationId: cast.feedbackSourceInvocationId }
              : {}),
            ...(isNonEmptyString(cast.feedbackArtifactId)
              ? { feedbackArtifactId: cast.feedbackArtifactId }
              : {}),
            ...(isNonEmptyString(cast.qualityGateId)
              ? { qualityGateId: cast.qualityGateId }
              : {}),
          },
        });
        events.taskRunChanged(cast.taskRunId);
        return ok(result);
      } catch (e) {
        return wrapErr<{ attempt: A2ARefinementAttempt; approval: Approval }>(
          e,
          STATE_INVALID_INPUT,
        );
      }
    },
  );
};
