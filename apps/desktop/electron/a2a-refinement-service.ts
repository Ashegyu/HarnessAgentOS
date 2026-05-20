import type {
  A2AEndpoint,
  A2ARefinementAttempt,
  AgentInvocation,
  AgentStreamEvent,
} from "@harness/core";
import type {
  A2AInvocationAdapter,
  A2AInvocationResult,
} from "@harness/agent";
import type { LocalStateService } from "@harness/storage";

export interface A2ARefinementServiceOptions {
  state: LocalStateService;
  endpoint: A2AEndpoint;
  adapter: Pick<A2AInvocationAdapter, "invoke">;
  emitStreamEvent?: (event: AgentStreamEvent) => void;
  now?: () => string;
  createArtifactUriNonce?: () => string;
}

export interface RunA2ARefinementAttemptInput {
  attemptId: string;
  instruction: string;
}

export interface RunA2ARefinementAttemptResult {
  attempt: A2ARefinementAttempt;
  invocation: AgentInvocation;
}

export interface A2ARefinementService {
  runApprovedAttempt(
    input: RunA2ARefinementAttemptInput,
    signal?: AbortSignal,
  ): Promise<RunA2ARefinementAttemptResult>;
}

export const createA2ARefinementService = (
  options: A2ARefinementServiceOptions,
): A2ARefinementService => {
  const now = options.now ?? (() => new Date().toISOString());
  const createArtifactUriNonce =
    options.createArtifactUriNonce ?? (() => Date.now().toString(36));

  return {
    async runApprovedAttempt(input, signal) {
      const attempt = await options.state.a2aRefinements.get(input.attemptId);
      if (!attempt) {
        throw new Error(`A2A refinement attempt not found: ${input.attemptId}`);
      }
      if (attempt.endpointId !== options.endpoint.id) {
        throw new Error(
          `A2A refinement endpoint mismatch: ${attempt.endpointId}`,
        );
      }
      if (!options.endpoint.enabled || !options.endpoint.trusted) {
        await options.state.a2aRefinements.update(attempt.id, {
          status: "stopped",
          stopReason: "endpoint_unavailable",
          completedAt: now(),
        });
        throw new Error(`A2A remote endpoint unavailable: ${options.endpoint.id}`);
      }

      const startedAt = now();
      const message = input.instruction.trim();
      const promptArtifact = await options.state.createArtifact({
        taskRunId: attempt.taskRunId,
        kind: "log",
        title: "A2A refinement prompt",
        uri: `harness:a2a-refinement-prompt/${attempt.taskRunId}/${createArtifactUriNonce()}`,
        summary: buildPromptSummary({ attempt, message }),
      });
      const invocation = await options.state.createAgentInvocation({
        taskRunId: attempt.taskRunId,
        provider: "codex",
        model: `a2a:${options.endpoint.id}`,
        promptArtifactId: promptArtifact.id,
      });
      await options.state.updateAgentInvocation(invocation.id, {
        status: "running",
        startedAt,
      });
      await options.state.a2aRefinements.update(attempt.id, {
        status: "running",
      });

      try {
        const result = await options.adapter.invoke(
          {
            invocationId: invocation.id,
            taskRunId: attempt.taskRunId,
            endpointId: options.endpoint.id,
            message,
            ...(attempt.parentRemoteContextId
              ? { contextId: attempt.parentRemoteContextId }
              : {}),
            ...(attempt.referenceTaskIds.length > 0
              ? { referenceTaskIds: attempt.referenceTaskIds }
              : {}),
            metadata: {
              harness: {
                refinementAttemptId: attempt.id,
                targetInvocationId: attempt.targetInvocationId,
                referenceArtifactIds: [...attempt.referenceArtifactIds],
              },
            },
          },
          (event) =>
            options.emitStreamEvent?.(
              withTaskRunScope(event, attempt.taskRunId),
            ),
          signal,
        );
        return await persistResult({
          state: options.state,
          attempt,
          invocation,
          endpoint: options.endpoint,
          result,
          startedAt,
          finishedAt: now(),
          createArtifactUriNonce,
        });
      } catch (error) {
        const finishedAt = now();
        await options.state.updateAgentInvocation(invocation.id, {
          status: cancelled(error) ? "cancelled" : "failed",
          errorCode: errorCode(error),
          errorMessage: errorMessage(error),
          finishedAt,
          latencyMs: elapsedMs(startedAt, finishedAt),
        });
        await options.state.a2aRefinements.update(attempt.id, {
          status: cancelled(error) ? "cancelled" : "failed",
          completedAt: finishedAt,
        });
        throw error;
      }
    },
  };
};

const persistResult = async (input: {
  state: LocalStateService;
  attempt: A2ARefinementAttempt;
  invocation: AgentInvocation;
  endpoint: A2AEndpoint;
  result: A2AInvocationResult;
  startedAt: string;
  finishedAt: string;
  createArtifactUriNonce: () => string;
}): Promise<RunA2ARefinementAttemptResult> => {
  await input.state.a2aRemoteAgents.upsertRemoteTaskRef(
    input.result.remoteTask,
  );
  const rawOutputArtifact = await input.state.createArtifact({
    taskRunId: input.attempt.taskRunId,
    kind: "log",
    title: "A2A refinement raw output",
    uri: `harness:a2a-refinement-output/${input.attempt.taskRunId}/${input.invocation.id}/${input.createArtifactUriNonce()}`,
    summary: input.result.outputText,
  });
  const terminalStatus = input.result.requiresInput
    ? "input_required"
    : input.result.requiresAuth
      ? "auth_required"
      : "succeeded";
  await input.state.updateAgentInvocation(input.invocation.id, {
    status: terminalStatus === "succeeded" ? "succeeded" : "failed",
    rawOutputArtifactId: rawOutputArtifact.id,
    finishedAt: input.finishedAt,
    latencyMs: elapsedMs(input.startedAt, input.finishedAt),
    ...(input.result.latencyMs !== undefined
      ? { latencyMs: input.result.latencyMs }
      : {}),
    ...(input.result.costEstimate !== undefined
      ? { costEstimate: input.result.costEstimate }
      : {}),
    ...(terminalStatus !== "succeeded"
      ? {
          errorCode:
            terminalStatus === "input_required"
              ? "A2A_REMOTE_INPUT_REQUIRED"
              : "A2A_REMOTE_AUTH_REQUIRED",
        }
      : {}),
  });
  const updatedAttempt = await input.state.a2aRefinements.update(
    input.attempt.id,
    {
      status: terminalStatus,
      remoteTaskId: input.result.remoteTask.remoteTaskId ?? null,
      remoteContextId: input.result.remoteTask.remoteContextId ?? null,
      ...(terminalStatus === "succeeded"
        ? {}
        : {
            stopReason:
              terminalStatus === "input_required"
                ? "input_required"
                : "auth_required",
          }),
      completedAt: input.finishedAt,
    },
  );
  const updatedInvocation = await input.state.agentInvocations.get(
    input.invocation.id,
  );
  if (!updatedInvocation) {
    throw new Error(`AgentInvocation ${input.invocation.id} not found`);
  }
  return { attempt: updatedAttempt, invocation: updatedInvocation };
};

const buildPromptSummary = (input: {
  attempt: A2ARefinementAttempt;
  message: string;
}): string =>
  [
    "A2A REFINEMENT REQUEST",
    `attempt: ${input.attempt.id}`,
    `targetInvocation: ${input.attempt.targetInvocationId}`,
    `parentRemoteTask: ${input.attempt.parentRemoteTaskId ?? "(none)"}`,
    `parentRemoteContext: ${input.attempt.parentRemoteContextId ?? "(none)"}`,
    `referenceTaskIds: ${input.attempt.referenceTaskIds.join(", ") || "(none)"}`,
    `referenceArtifactIds: ${input.attempt.referenceArtifactIds.join(", ") || "(none)"}`,
    "",
    input.message,
  ].join("\n");

const cancelled = (error: unknown): boolean =>
  isRecord(error) && error.name === "AbortError";

const errorCode = (error: unknown): string =>
  isRecord(error) && typeof error.code === "string"
    ? error.code
    : isRecord(error) && typeof error.name === "string"
      ? error.name
      : "A2A_REFINEMENT_ERROR";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const elapsedMs = (startedAt: string, finishedAt: string): number | null => {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withTaskRunScope = (
  event: AgentStreamEvent,
  taskRunId: string,
): AgentStreamEvent =>
  "taskRunId" in event && event.taskRunId
    ? event
    : { ...event, taskRunId };
