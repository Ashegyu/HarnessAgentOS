import type {
  A2AEndpoint,
  AgentProfile,
  AgentStreamEvent,
} from "@harness/core";
import {
  A2AInvocationAdapter,
  A2AInvocationError,
  A2AWorkerInvoker,
  OfficialA2AClientPort,
  type A2AWorkerInvokeInput,
  type A2AWorkerOutcome,
} from "@harness/agent";
import type { LocalStateService } from "@harness/storage";

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
): PersistentA2AWorkerInvoker => ({
  async invokeForWorker(input, signal) {
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
  },
});

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
        kind: "log",
        title: `A2A remote prompt: ${options.endpoint.name}`,
        uri: `harness:a2a-prompt/${input.taskRunId}/${createArtifactUriNonce()}`,
        summary: input.userRequest,
      });
      const invocation = await options.state.createAgentInvocation({
        taskRunId: input.taskRunId,
        provider: invocationProvider(input.profile),
        model: `a2a:${options.endpoint.id}`,
        promptArtifactId: promptArtifact.id,
      });
      await options.state.updateAgentInvocation(invocation.id, {
        status: "running",
        startedAt,
      });

      const invoker = new A2AWorkerInvoker({
        endpointId: options.endpoint.id,
        adapter: options.adapter,
        createInvocationId: () => invocation.id,
        onStreamEvent: options.emitStreamEvent,
        onRemoteTaskRef: async (ref) => {
          await options.state.a2aRemoteAgents.upsertRemoteTaskRef(ref);
        },
      });

      try {
        const outcome = await invoker.invokeForWorker(input, signal);
        const finishedAt = now();
        const rawOutputArtifact = await options.state.createArtifact({
          taskRunId: input.taskRunId,
          kind: "log",
          title: `A2A remote raw output: ${options.endpoint.name}`,
          uri: `harness:a2a-output/${input.taskRunId}/${invocation.id}/${createArtifactUriNonce()}`,
          summary: outcome.outputText,
        });
        await options.state.updateAgentInvocation(invocation.id, {
          status: "succeeded",
          rawOutputArtifactId: rawOutputArtifact.id,
          finishedAt,
          latencyMs: elapsedMs(startedAt, finishedAt),
        });
        return outcome;
      } catch (error) {
        const finishedAt = now();
        await options.state.updateAgentInvocation(invocation.id, {
          status: cancelled(error) ? "cancelled" : "failed",
          errorCode: errorCode(error),
          errorMessage: errorMessage(error),
          finishedAt,
          latencyMs: elapsedMs(startedAt, finishedAt),
        });
        throw error;
      }
    },
  };
};

const invocationProvider = (profile: AgentProfile): "claude" | "codex" =>
  profile.provider === "claude" ? "claude" : "codex";

const cancelled = (error: unknown): boolean =>
  error instanceof A2AInvocationError
    ? error.code === "A2A_REMOTE_CANCELLED"
    : isRecord(error) && error.name === "AbortError";

const errorCode = (error: unknown): string =>
  error instanceof A2AInvocationError
    ? error.code
    : isRecord(error) && typeof error.name === "string"
      ? error.name
      : "A2A_REMOTE_ERROR";

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
