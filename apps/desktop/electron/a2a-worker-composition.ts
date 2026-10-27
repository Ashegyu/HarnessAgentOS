import type {
  A2AEndpoint,
  AgentProfile,
  AgentStreamEvent,
} from "@harness/core";
import { AsyncWorkScope, createRedactedAgentStream } from "@harness/core";
import {
  A2AInvocationAdapter,
  A2AInvocationError,
  A2AWorkerInvoker,
  OfficialA2AClientPort,
  estimateModelUsage,
  type A2AWorkerInvokeInput,
  type A2AWorkerOutcome,
} from "@harness/agent";
import type { LocalStateService } from "@harness/storage";
import { redactSecrets } from "@harness/learner";

export interface PersistentA2AWorkerInvokerOptions {
  state: LocalStateService;
  endpoint: A2AEndpoint;
  adapter: Pick<A2AInvocationAdapter, "invoke">;
  emitStreamEvent?: (event: AgentStreamEvent) => void;
  now?: () => string;
  createArtifactUriNonce?: () => string;
}

export interface PersistentA2AWorkerInvoker {
  invokeForWorker(
    input: A2AWorkerInvokeInput,
    signal?: AbortSignal,
  ): Promise<A2AWorkerOutcome>;
}

export interface A2AWorkerRouterOptions {
  state: LocalStateService;
  localInvoker: PersistentA2AWorkerInvoker;
  emitStreamEvent?: (event: AgentStreamEvent) => void;
  now?: () => string;
  createArtifactUriNonce?: () => string;
  createRemoteInvoker?: (endpoint: A2AEndpoint) => PersistentA2AWorkerInvoker;
}

export const createA2AWorkerRouter = (
  options: A2AWorkerRouterOptions,
): PersistentA2AWorkerInvoker & { shutdown(): Promise<void> } => {
  const operations = new AsyncWorkScope();
  const controllers = new Set<AbortController>();
  const invoke = async (input: A2AWorkerInvokeInput, signal: AbortSignal): Promise<A2AWorkerOutcome> => {
    if (!input.remoteEndpointId) {
      return options.localInvoker.invokeForWorker(input, signal);
    }
    const endpoint = await options.state.a2aRemoteAgents.getEndpoint(
      input.remoteEndpointId,
    );
    if (!endpoint) {
      throw new Error(`A2A remote endpoint not found: ${input.remoteEndpointId}`);
    }
    if (!endpoint.enabled || !endpoint.trusted) {
      throw new Error(
        `A2A remote endpoint unavailable: ${input.remoteEndpointId}`,
      );
    }
    const remoteInvoker =
      options.createRemoteInvoker?.(endpoint) ??
      createPersistentA2AWorkerInvoker({
        state: options.state,
        endpoint,
        adapter: new A2AInvocationAdapter({
          timeoutMs: input.profile.tuning.timeoutMs,
          client: new OfficialA2AClientPort({
            endpoint,
            timeoutMs: input.profile.tuning.timeoutMs,
          }),
        }),
        emitStreamEvent: options.emitStreamEvent,
        now: options.now,
        createArtifactUriNonce: options.createArtifactUriNonce,
      });
    return remoteInvoker.invokeForWorker(input, signal);
  };
  return {
    invokeForWorker(input, signal) {
      return operations.run(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        controllers.add(controller);
        try { return await invoke(input, controller.signal); }
        finally { controllers.delete(controller); signal?.removeEventListener("abort", abort); }
      });
    },
    async shutdown() {
      operations.seal();
      for (const controller of controllers) controller.abort();
      await operations.drain();
    },
  };
};

export const createPersistentA2AWorkerInvoker = (
  options: PersistentA2AWorkerInvokerOptions,
): PersistentA2AWorkerInvoker => {
  const now = options.now ?? (() => new Date().toISOString());
  const createArtifactUriNonce =
    options.createArtifactUriNonce ?? (() => Date.now().toString(36));

  return {
    async invokeForWorker(input, signal) {
      const startedAt = now();
      const promptArtifact = await options.state.createArtifact({
        taskRunId: input.taskRunId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        kind: "log",
        title: redactSecrets(`A2A remote prompt: ${options.endpoint.name}`, 1_000),
        uri: `harness:a2a-prompt/${input.taskRunId}/${createArtifactUriNonce()}`,
        summary: redactSecrets(input.userRequest, 80_000),
      });
      const invocation = await options.state.createAgentInvocation({
        taskRunId: input.taskRunId,
        provider: invocationProvider(input.profile),
        model: `a2a:${options.endpoint.id}`,
        promptArtifactId: promptArtifact.id,
        profileId: input.profile.id,
        ...(input.stepId ? { stepId: input.stepId } : {}),
      });
      await options.state.updateAgentInvocation(invocation.id, {
        status: "running",
        startedAt,
      });

      const streamAudit = createRedactedAgentStream({ emit: event => options.emitStreamEvent?.(event) });
      const invoker = new A2AWorkerInvoker({
        endpointId: options.endpoint.id,
        adapter: options.adapter,
        createInvocationId: () => invocation.id,
        onStreamEvent: (event) =>
          streamAudit.push(withTaskRunScope(event, input.taskRunId)),
        onRemoteTaskRef: async (ref) => {
          await options.state.a2aRemoteAgents.upsertRemoteTaskRef(ref);
        },
      });

      try {
        // Preserve executable preimages, patches and arguments. Only audit
        // copies are redacted; the returned proposal remains the model output.
        const outcome = await invoker.invokeForWorker(input, signal);
        streamAudit.flush();
        const finishedAt = now();
        const rawOutputArtifact = await options.state.createArtifact({
          taskRunId: input.taskRunId,
          ...(input.stepId ? { stepId: input.stepId } : {}),
          kind: "log",
          title: redactSecrets(`A2A remote raw output: ${options.endpoint.name}`, 1_000),
          uri: `harness:a2a-output/${input.taskRunId}/${invocation.id}/${createArtifactUriNonce()}`,
          summary: redactSecrets(outcome.outputText, 200_000),
        });
        const usageEstimate = estimateModelUsage({
          provider: invocationProvider(input.profile),
          model: `a2a:${options.endpoint.id}`,
          prompt: input.userRequest,
          output: outcome.outputText,
        });
        const usagePatch = {
          inputTokens: usageEstimate.inputTokens,
          outputTokens: usageEstimate.outputTokens,
          totalTokens: usageEstimate.totalTokens,
          usageApproximate: usageEstimate.approximate,
        };
        await options.state.updateAgentInvocation(
          invocation.id,
          outcome.lifecycle
            ? {
                status: "failed",
                rawOutputArtifactId: rawOutputArtifact.id,
                errorCode: lifecycleErrorCode(outcome.lifecycle.kind),
                errorMessage: redactSecrets(outcome.lifecycle.message, 2_000),
                finishedAt,
                latencyMs: elapsedMs(startedAt, finishedAt),
                ...usagePatch,
              }
            : {
                status: "succeeded",
                rawOutputArtifactId: rawOutputArtifact.id,
                finishedAt,
                latencyMs: elapsedMs(startedAt, finishedAt),
                ...usagePatch,
              },
        );
        return outcome;
      } catch (error) {
        const finishedAt = now();
        await options.state.updateAgentInvocation(invocation.id, {
          status: cancelled(error) ? "cancelled" : "failed",
          errorCode: errorCode(error),
          errorMessage: redactSecrets(errorMessage(error), 2_000),
          finishedAt,
          latencyMs: elapsedMs(startedAt, finishedAt),
        });
        throw redactedError(error);
      } finally {
        try { streamAudit.flush(); } catch { /* Telemetry must not replace the terminal outcome. */ }
      }
    },
  };
};

const invocationProvider = (_profile: AgentProfile): "codex" => "codex";

const cancelled = (error: unknown): boolean =>
  error instanceof A2AInvocationError
    ? error.code === "A2A_REMOTE_CANCELLED"
    : isRecord(error) && error.name === "AbortError";

const errorCode = (error: unknown): string =>
  error instanceof A2AInvocationError
    ? error.code
    : isRecord(error) && typeof error.name === "string" && SAFE_ERROR_NAMES.has(error.name)
      ? error.name
      : "A2A_REMOTE_ERROR";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const redactedError = (error: unknown): unknown => {
  const message = redactSecrets(errorMessage(error), 2_000);
  if (error instanceof A2AInvocationError) {
    return message === error.message ? error : new A2AInvocationError(error.code, error.remoteState, message);
  }
  const name = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
  const originalCode = isRecord(error) ? error.code : undefined;
  const code = typeof originalCode === "string" && SAFE_TRANSPORT_CODES.has(originalCode) ? originalCode : undefined;
  if (error instanceof Error && message === error.message && name === error.name && code === originalCode) return error;
  const redacted = new Error(message);
  redacted.name = name;
  if (code !== undefined) Object.assign(redacted, { code });
  return redacted;
};

const SAFE_ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "URIError", "EvalError", "AbortError", "TimeoutError"]);
const SAFE_TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR"]);

const elapsedMs = (startedAt: string, finishedAt: string): number | null => {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
};

const lifecycleErrorCode = (
  kind: NonNullable<A2AWorkerOutcome["lifecycle"]>["kind"],
): string =>
  kind === "requires_input"
    ? "A2A_REMOTE_INPUT_REQUIRED"
    : "A2A_REMOTE_AUTH_REQUIRED";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withTaskRunScope = (
  event: AgentStreamEvent,
  taskRunId: string,
): AgentStreamEvent =>
  "taskRunId" in event && event.taskRunId
    ? event
    : { ...event, taskRunId };
