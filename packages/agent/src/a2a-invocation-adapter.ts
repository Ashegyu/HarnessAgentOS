import type {
  A2ARemoteTaskRef,
  A2ARemoteTaskState,
  AgentProposedAction,
  AgentProgressStage,
  AgentStreamEvent,
} from "@harness/core";
import {
  parseAgentPlan,
  type ParseAgentPlanResult,
} from "./agent-output-parser.ts";

export interface A2AInvocationRequest {
  invocationId: string;
  taskRunId: string;
  endpointId: string;
  message: string;
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface A2AClientArtifact {
  id?: string;
  title?: string;
  mimeType?: string;
  text?: string;
  data?: unknown;
  url?: string;
}

export type A2AClientEvent =
  | {
      type: "task-state";
      state: A2ARemoteTaskState;
      remoteTaskId?: string;
      remoteContextId?: string;
      message?: string;
    }
  | { type: "message"; text: string }
  | { type: "artifact"; artifact: A2AClientArtifact }
  | { type: "usage"; latencyMs?: number; costEstimate?: number };

export interface A2AClientPort {
  invoke(
    request: A2AInvocationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<A2AClientEvent> | Promise<AsyncIterable<A2AClientEvent>>;
}

export interface NormalizedA2AArtifact {
  remoteArtifactId?: string;
  title: string;
  contentType: string;
  text?: string;
  data?: unknown;
  url?: string;
}

export interface A2AInvocationResult {
  outputText: string;
  remoteTask: A2ARemoteTaskRef;
  artifacts: NormalizedA2AArtifact[];
  normalizedEvents: AgentStreamEvent[];
  latencyMs?: number;
  costEstimate?: number;
  requiresInput: boolean;
  requiresAuth: boolean;
}

export interface A2AWorkerOutcome {
  outputText: string;
  proposedActions?: AgentProposedAction[];
  lifecycle?: A2AWorkerLifecycleInterruption;
}

export type A2AWorkerLifecycleInterruption =
  | {
      kind: "requires_input";
      remoteState: "input-required";
      message: "Remote A2A worker requires user input";
    }
  | {
      kind: "requires_auth";
      remoteState: "auth-required";
      message: "Remote A2A worker requires authentication";
    };

export type A2AInvocationErrorCode =
  | "A2A_REMOTE_FAILED"
  | "A2A_REMOTE_CANCELLED"
  | "A2A_REMOTE_REJECTED";

export class A2AInvocationError extends Error {
  readonly code: A2AInvocationErrorCode;
  readonly remoteState: A2ARemoteTaskState;

  constructor(
    code: A2AInvocationErrorCode,
    remoteState: A2ARemoteTaskState,
    message: string,
  ) {
    super(message);
    this.name = "A2AInvocationError";
    this.code = code;
    this.remoteState = remoteState;
  }
}

export interface A2AInvocationAdapterOptions {
  client: A2AClientPort;
  now?: () => string;
}

export class A2AInvocationAdapter {
  private readonly client: A2AClientPort;
  private readonly now: () => string;

  constructor(options: A2AInvocationAdapterOptions) {
    this.client = options.client;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async invoke(
    request: A2AInvocationRequest,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<A2AInvocationResult> {
    const normalizedEvents: AgentStreamEvent[] = [];
    const artifacts: NormalizedA2AArtifact[] = [];
    const textParts: string[] = [];
    let latencyMs: number | undefined;
    let costEstimate: number | undefined;
    let remoteTask: A2ARemoteTaskRef = {
      invocationId: request.invocationId,
      endpointId: request.endpointId,
      state: "unknown",
    };

    const emit = (event: AgentStreamEvent): void => {
      normalizedEvents.push(event);
      onEvent(event);
    };

    const stream = await this.client.invoke(request, signal);
    for await (const event of stream) {
      if (event.type === "task-state") {
        const at = this.now();
        remoteTask = {
          ...remoteTask,
          remoteTaskId: event.remoteTaskId ?? remoteTask.remoteTaskId,
          remoteContextId: event.remoteContextId ?? remoteTask.remoteContextId,
          state: event.state,
          lastEventAt: at,
        };
        emit({
          type: "progress",
          invocationId: request.invocationId,
          taskRunId: request.taskRunId,
          stage: stageForState(event.state),
          message: event.message ?? messageForState(event.state),
          detail: `A2A state: ${event.state}`,
          at,
        });

        const errorCode = errorCodeForState(event.state);
        if (errorCode) {
          if (event.state === "canceled") {
            emit({
              type: "cancelled",
              invocationId: request.invocationId,
              taskRunId: request.taskRunId,
            });
          } else {
            emit({
              type: "failed",
              invocationId: request.invocationId,
              taskRunId: request.taskRunId,
              errorCode,
              message: event.message ?? messageForState(event.state),
            });
          }
          throw new A2AInvocationError(
            errorCode,
            event.state,
            event.message ?? messageForState(event.state),
          );
        }
        continue;
      }

      if (event.type === "message") {
        if (event.text.length > 0) {
          textParts.push(event.text);
          emit({
            type: "assistant_text",
            invocationId: request.invocationId,
            taskRunId: request.taskRunId,
            text: event.text,
          });
        }
        continue;
      }

      if (event.type === "artifact") {
        artifacts.push(normalizeArtifact(event.artifact));
        continue;
      }

      latencyMs = event.latencyMs ?? latencyMs;
      costEstimate = event.costEstimate ?? costEstimate;
    }

    const completed = remoteTask.state === "completed";
    if (completed) {
      emit({
        type: "result",
        invocationId: request.invocationId,
        taskRunId: request.taskRunId,
        latencyMs,
        costEstimate,
      });
    }

    return {
      outputText: textParts.join("\n\n"),
      remoteTask,
      artifacts,
      normalizedEvents,
      latencyMs,
      costEstimate,
      requiresInput: remoteTask.state === "input-required",
      requiresAuth: remoteTask.state === "auth-required",
    };
  }
}

export const parseA2AInvocationPlan = (
  result: Pick<A2AInvocationResult, "outputText">,
): ParseAgentPlanResult => parseAgentPlan(result.outputText);

/**
 * Bridge for future orchestration integration. It intentionally exposes
 * remote actions only as proposed actions; WorkerRunner is the component
 * that turns these into pending Approval rows.
 */
export const a2aInvocationToWorkerOutcome = (
  result: Pick<
    A2AInvocationResult,
    "outputText" | "requiresInput" | "requiresAuth"
  >,
): A2AWorkerOutcome => {
  if (result.requiresInput) {
    return {
      outputText: result.outputText,
      lifecycle: {
        kind: "requires_input",
        remoteState: "input-required",
        message: "Remote A2A worker requires user input",
      },
    };
  }
  if (result.requiresAuth) {
    return {
      outputText: result.outputText,
      lifecycle: {
        kind: "requires_auth",
        remoteState: "auth-required",
        message: "Remote A2A worker requires authentication",
      },
    };
  }
  const parsed = parseA2AInvocationPlan(result);
  if (!parsed.ok || parsed.plan.proposedActions.length === 0) {
    return { outputText: result.outputText };
  }
  return {
    outputText: result.outputText,
    proposedActions: parsed.plan.proposedActions.slice(),
  };
};

const stageForState = (state: A2ARemoteTaskState): AgentProgressStage => {
  if (state === "submitted") return "queued";
  if (state === "completed") return "complete";
  return "cli";
};

const messageForState = (state: A2ARemoteTaskState): string => {
  switch (state) {
    case "submitted":
      return "A2A remote task submitted";
    case "working":
      return "A2A remote agent working";
    case "input-required":
      return "A2A remote agent requires input";
    case "auth-required":
      return "A2A remote agent requires authentication";
    case "completed":
      return "A2A remote task completed";
    case "failed":
      return "A2A remote task failed";
    case "canceled":
      return "A2A remote task canceled";
    case "rejected":
      return "A2A remote task rejected";
    case "unknown":
      return "A2A remote task state unknown";
  }
};

const errorCodeForState = (
  state: A2ARemoteTaskState,
): A2AInvocationErrorCode | null => {
  switch (state) {
    case "failed":
      return "A2A_REMOTE_FAILED";
    case "canceled":
      return "A2A_REMOTE_CANCELLED";
    case "rejected":
      return "A2A_REMOTE_REJECTED";
    default:
      return null;
  }
};

const normalizeArtifact = (artifact: A2AClientArtifact): NormalizedA2AArtifact => {
  const contentType = artifact.mimeType ?? contentTypeForArtifact(artifact);
  return {
    remoteArtifactId: artifact.id,
    title: artifact.title ?? artifact.id ?? "A2A artifact",
    contentType,
    text: artifact.text,
    data: artifact.data,
    url: artifact.url,
  };
};

const contentTypeForArtifact = (artifact: A2AClientArtifact): string => {
  if (typeof artifact.url === "string" && artifact.url.length > 0) {
    return "text/uri-list";
  }
  if (typeof artifact.text === "string") return "text/plain";
  if (artifact.data !== undefined) return "application/json";
  return "application/octet-stream";
};
