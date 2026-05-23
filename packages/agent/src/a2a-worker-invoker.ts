import type {
  A2ARemoteTaskRef,
  AgentProfile,
  AgentStreamEvent,
} from "@harness/core";
import {
  a2aInvocationToWorkerOutcome,
  type A2AInvocationAdapter,
  type A2AWorkerOutcome,
} from "./a2a-invocation-adapter.ts";
import { NON_INTERACTIVE_AGENT_POLICY } from "./agent-prompt-builder.ts";

export interface A2AWorkerInvokeInput {
  taskRunId: string;
  stepId?: string;
  profile: AgentProfile;
  userRequest: string;
  remoteEndpointId?: string;
}

export type A2AWorkerInvocationIdFactory = (
  input: A2AWorkerInvokeInput,
) => string;

export interface A2AWorkerInvokerOptions {
  endpointId: string;
  adapter: Pick<A2AInvocationAdapter, "invoke">;
  createInvocationId?: A2AWorkerInvocationIdFactory;
  onStreamEvent?: (event: AgentStreamEvent) => void;
  onRemoteTaskRef?: (ref: A2ARemoteTaskRef) => void | Promise<void>;
}

/**
 * SDK-free orchestration seam for remote A2A workers.
 *
 * The class intentionally implements the same structural shape as
 * WorkerCliInvoker without importing @harness/orchestration. It performs
 * no filesystem/shell/git side effects; proposed actions remain data that
 * WorkerRunner turns into pending Approval rows.
 */
export class A2AWorkerInvoker {
  private readonly endpointId: string;
  private readonly adapter: Pick<A2AInvocationAdapter, "invoke">;
  private readonly createInvocationId: A2AWorkerInvocationIdFactory;
  private readonly onStreamEvent?: (event: AgentStreamEvent) => void;
  private readonly onRemoteTaskRef?: (
    ref: A2ARemoteTaskRef,
  ) => void | Promise<void>;

  constructor(options: A2AWorkerInvokerOptions) {
    this.endpointId = options.endpointId;
    this.adapter = options.adapter;
    this.createInvocationId =
      options.createInvocationId ?? defaultCreateInvocationId;
    this.onStreamEvent = options.onStreamEvent;
    this.onRemoteTaskRef = options.onRemoteTaskRef;
  }

  async invokeForWorker(
    input: A2AWorkerInvokeInput,
    signal?: AbortSignal,
  ): Promise<A2AWorkerOutcome> {
    const invocationId = this.createInvocationId(input);
    const result = await this.adapter.invoke(
      {
        invocationId,
        taskRunId: input.taskRunId,
        endpointId: this.endpointId,
        message: buildA2AWorkerMessage(input.userRequest),
      },
      (event) => this.onStreamEvent?.(event),
      signal,
    );
    await this.onRemoteTaskRef?.(result.remoteTask);
    return a2aInvocationToWorkerOutcome(result);
  }
}

const defaultCreateInvocationId: A2AWorkerInvocationIdFactory = (input) =>
  `a2a_${input.taskRunId}_${Date.now().toString(36)}`;

const buildA2AWorkerMessage = (userRequest: string): string =>
  [
    NON_INTERACTIVE_AGENT_POLICY.trim(),
    "USER REQUEST",
    userRequest.trim(),
  ].join("\n\n");
