import { randomUUID } from "node:crypto";
import type {
  A2AEndpoint,
  A2ARemoteTaskState,
  A2ATransport,
} from "@harness/core";
import type {
  A2AClientArtifact,
  A2AClientEvent,
  A2AClientPort,
  A2AInvocationRequest,
} from "./a2a-invocation-adapter.ts";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import type { MessageSendParams } from "@a2a-js/sdk";
import { createA2ARequestScope, createA2ABoundedFetch, createA2AResponseMeter, closeA2AIterator, resolveA2ALimits,
  type A2AResponseLimits } from "./a2a-resource-limits.ts";

type TransportProtocolName = "JSONRPC" | "HTTP+JSON" | "GRPC";

export interface OfficialA2AClientFactoryOptions {
  preferredTransports: TransportProtocolName[];
  signal?: AbortSignal;
}

export interface OfficialA2AClientFactory {
  createFromUrl(baseUrl: string, path?: string): Promise<OfficialA2ASdkClient>;
}

export interface OfficialA2ASdkClient {
  sendMessageStream(
    params: MessageSendParams,
    options?: RequestOptions,
  ): AsyncIterable<unknown>;
  sendMessage?(
    params: MessageSendParams,
    options?: RequestOptions,
  ): Promise<unknown>;
}

export interface OfficialA2AClientPortOptions {
  endpoint: A2AEndpoint;
  timeoutMs?: number;
  createClientFactory?: (
    options: OfficialA2AClientFactoryOptions,
  ) => OfficialA2AClientFactory;
  createMessageId?: () => string;
  redactText?: (text: string) => string;
  limits?: Partial<A2AResponseLimits>;
  fetchImpl?: typeof fetch;
}

export class OfficialA2AClientPort implements A2AClientPort {
  private readonly endpoint: A2AEndpoint;
  private readonly timeoutMs?: number;
  private readonly createClientFactory?: (
    options: OfficialA2AClientFactoryOptions,
  ) => OfficialA2AClientFactory;
  private readonly createMessageId: () => string;
  private readonly redactText: (text: string) => string;
  private readonly limits: A2AResponseLimits;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OfficialA2AClientPortOptions) {
    this.endpoint = options.endpoint;
    this.timeoutMs = options.timeoutMs;
    this.createClientFactory = options.createClientFactory;
    this.createMessageId = options.createMessageId ?? randomUUID;
    // Transport output feeds executable plan parsing. The main boundary masks
    // audit copies; limits reject excess data instead of silently rewriting it.
    this.redactText = options.redactText ?? ((text) => text);
    this.limits = resolveA2ALimits(options.limits);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *invoke(
    request: A2AInvocationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<A2AClientEvent> {
    const signalScope = createA2ARequestScope(signal, this.timeoutMs);
    const meter = createA2AResponseMeter(this.limits);
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      signalScope.check();
      const options = { preferredTransports: [transportPreference(this.endpoint.preferredTransport)], signal: signalScope.signal };
      const boundedFetch = createA2ABoundedFetch(signalScope, this.limits, this.fetchImpl);
      const factory = this.createClientFactory?.(options) ?? defaultCreateClientFactory(options,
        boundedFetch(this.limits.maxResponseBytes), boundedFetch(this.limits.maxAgentCardBytes));
      const target = clientTarget(this.endpoint);
      const client = await signalScope.run(() => factory.createFromUrl(target.baseUrl, target.path));
      const params = messageSendParams(request, this.createMessageId());
      if (typeof client.sendMessageStream === "function") {
        iterator = client.sendMessageStream(params, {
          signal: signalScope.signal,
        })[Symbol.asyncIterator]();
        for (;;) {
          const next = await signalScope.run(() => iterator!.next());
          if (next.done) break;
          meter.event(next.value);
          for (const event of this.mapSdkEvent(next.value, meter)) {
            signalScope.check();
            yield event;
          }
        }
        return;
      }

      if (typeof client.sendMessage === "function") {
        const event = await signalScope.run(() => client.sendMessage!(params, {
          signal: signalScope.signal,
        }));
        meter.event(event);
        for (const mapped of this.mapSdkEvent(event, meter)) {
          signalScope.check();
          yield mapped;
        }
      }
    } catch (error) {
      if (signalScope.signal.aborted) throw signalScope.signal.reason;
      throw error;
    } finally {
      signalScope.dispose();
      closeA2AIterator(iterator);
    }
  }

  private *mapSdkEvent(event: unknown, meter: ReturnType<typeof createA2AResponseMeter>): Iterable<A2AClientEvent> {
    if (!isRecord(event)) return;
    const kind = event.kind;
    if (kind === "task") {
      const status = asRecord(event.status);
      const state = normalizeState(status?.state);
      const message = messageText(status?.message, this.redactText);
      yield cleanEvent({
        type: "task-state",
        state,
        remoteTaskId: stringValue(event.id),
        remoteContextId: stringValue(event.contextId),
        message,
      });
      if (message) yield { type: "message", text: message };
      yield* this.mapTaskArtifacts(event, meter);
      return;
    }

    if (kind === "status-update") {
      const status = asRecord(event.status);
      const state = normalizeState(status?.state);
      const message = messageText(status?.message, this.redactText);
      yield cleanEvent({
        type: "task-state",
        state,
        remoteTaskId: stringValue(event.taskId),
        remoteContextId: stringValue(event.contextId),
        message,
      });
      if (message) yield { type: "message", text: message };
      return;
    }

    if (kind === "artifact-update") {
      meter.artifact(event.artifact);
      const artifact = artifactFromSdk(event.artifact, this.redactText);
      if (artifact) yield { type: "artifact", artifact };
      return;
    }

    if (kind === "message") {
      const text = messageText(event, this.redactText);
      if (text) yield { type: "message", text };
    }
  }

  private *mapTaskArtifacts(event: Record<string, unknown>, meter: ReturnType<typeof createA2AResponseMeter>): Iterable<A2AClientEvent> {
    if (!Array.isArray(event.artifacts)) return;
    for (const artifactLike of event.artifacts) {
      meter.artifact(artifactLike);
      const artifact = artifactFromSdk(artifactLike, this.redactText);
      if (artifact) yield { type: "artifact", artifact };
    }
  }
}

const defaultCreateClientFactory = (
  options: OfficialA2AClientFactoryOptions,
  fetchImpl: typeof fetch,
  cardFetchImpl: typeof fetch,
): OfficialA2AClientFactory => {
  const merged = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    preferredTransports: options.preferredTransports,
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: cardFetchImpl }),
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
  });
  const factory = new ClientFactory(merged);
  return {
    createFromUrl: async (baseUrl, path) =>
      (await factory.createFromUrl(baseUrl, path)) as Client,
  };
};

const messageSendParams = (
  request: A2AInvocationRequest,
  messageId: string,
): MessageSendParams => {
  const message: MessageSendParams["message"] & {
    contextId?: string;
    taskId?: string;
    referenceTaskIds?: readonly string[];
    metadata?: Record<string, unknown>;
  } = {
    kind: "message",
    messageId,
    role: "user",
    parts: [{ kind: "text", text: request.message }],
  };
  if (request.contextId) message.contextId = request.contextId;
  if (request.taskId) message.taskId = request.taskId;
  if (request.referenceTaskIds && request.referenceTaskIds.length > 0) {
    message.referenceTaskIds = [...request.referenceTaskIds];
  }
  if (request.metadata && Object.keys(request.metadata).length > 0) {
    message.metadata = request.metadata;
  }
  return { message };
};

const transportPreference = (
  transport: A2ATransport,
): TransportProtocolName => {
  switch (transport) {
    case "http-json":
      return "HTTP+JSON";
    case "grpc":
      return "GRPC";
    case "json-rpc":
      return "JSONRPC";
  }
};

const clientTarget = (
  endpoint: A2AEndpoint,
): { baseUrl: string; path?: string } => {
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  try {
    const base = new URL(baseUrl);
    const card = new URL(endpoint.agentCardUrl);
    if (card.origin === base.origin) {
      return { baseUrl, path: `${card.pathname}${card.search}` };
    }
    return { baseUrl: endpoint.agentCardUrl, path: "" };
  } catch {
    return { baseUrl };
  }
};

const normalizeState = (state: unknown): A2ARemoteTaskState =>
  state === "submitted" ||
  state === "working" ||
  state === "input-required" ||
  state === "auth-required" ||
  state === "completed" ||
  state === "failed" ||
  state === "canceled" ||
  state === "rejected" ||
  state === "unknown"
    ? state
    : "unknown";

const messageText = (
  message: unknown,
  redactText: (text: string) => string,
): string | undefined => {
  if (!isRecord(message) || !Array.isArray(message.parts)) return undefined;
  const parts = message.parts
    .map((part) => (isRecord(part) && part.kind === "text" ? part.text : undefined))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .map(redactText);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

const artifactFromSdk = (
  value: unknown,
  redactText: (text: string) => string,
): A2AClientArtifact | null => {
  if (!isRecord(value)) return null;
  const parts = Array.isArray(value.parts) ? value.parts : [];
  const textParts: string[] = [];
  const dataParts: unknown[] = [];
  let url: string | undefined;

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.kind === "text" && typeof part.text === "string") {
      textParts.push(redactText(part.text));
      continue;
    }
    if (part.kind === "data" && "data" in part) {
      dataParts.push(part.data);
      continue;
    }
    if (part.kind === "file" && isRecord(part.file)) {
      url = stringValue(part.file.uri) ?? url;
    }
  }

  const text = textParts.length > 0 ? textParts.join("\n\n") : undefined;
  const data =
    dataParts.length === 1
      ? dataParts[0]
      : dataParts.length > 1
        ? dataParts
        : undefined;
  const artifact: A2AClientArtifact = {
    id: stringValue(value.artifactId) ?? stringValue(value.id),
    title:
      stringValue(value.name) ??
      stringValue(value.title) ??
      stringValue(value.artifactId) ??
      stringValue(value.id),
    mimeType: stringValue(value.mimeType) ?? contentType({ text, data, url }),
  };
  if (text) artifact.text = text;
  if (data !== undefined) artifact.data = data;
  if (url) artifact.url = url;
  return artifact;
};

const contentType = (artifact: {
  text?: string;
  data?: unknown;
  url?: string;
}): string => {
  if (artifact.data !== undefined) return "application/json";
  if (artifact.text !== undefined) return "text/plain";
  if (artifact.url !== undefined) return "text/uri-list";
  return "application/octet-stream";
};

const cleanEvent = (
  event: Extract<A2AClientEvent, { type: "task-state" }>,
): Extract<A2AClientEvent, { type: "task-state" }> => {
  const clean: Extract<A2AClientEvent, { type: "task-state" }> = {
    type: "task-state",
    state: event.state,
  };
  if (event.remoteTaskId) clean.remoteTaskId = event.remoteTaskId;
  if (event.remoteContextId) clean.remoteContextId = event.remoteContextId;
  if (event.message) clean.message = event.message;
  return clean;
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;
