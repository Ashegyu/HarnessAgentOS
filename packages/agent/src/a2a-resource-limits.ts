import { A2A_REQUEST_TIMEOUT, A2A_RESPONSE_LIMIT, type A2ARemoteTaskState } from "@harness/core";

export type A2AInvocationErrorCode = "A2A_REMOTE_FAILED" | "A2A_REMOTE_CANCELLED" | "A2A_REMOTE_REJECTED" |
  typeof A2A_REQUEST_TIMEOUT | typeof A2A_RESPONSE_LIMIT;

export class A2AInvocationError extends Error {
  constructor(readonly code: A2AInvocationErrorCode, readonly remoteState: A2ARemoteTaskState, message: string) {
    super(message);
    this.name = "A2AInvocationError";
  }
}

export const DEFAULT_A2A_LIMITS = {
  maxAgentCardBytes: 256 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxEventBytes: 1024 * 1024,
  maxEvents: 4096,
  maxArtifacts: 128,
  maxArtifactBytes: 1024 * 1024,
  maxTotalArtifactBytes: 4 * 1024 * 1024,
  maxTextBytes: 4 * 1024 * 1024,
  maxRetainedEvents: 256,
  maxRetainedEventBytes: 256 * 1024,
} as const;
export type A2AResponseLimits = { [K in keyof typeof DEFAULT_A2A_LIMITS]: number };
export const DEFAULT_A2A_TIMEOUT_MS = 300_000;

export const resolveA2ALimits = (overrides: Partial<A2AResponseLimits> = {}): A2AResponseLimits => {
  const limits = { ...DEFAULT_A2A_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key.startsWith("maxRetained") ? 1 : 0)) {
      throw new RangeError(`Invalid A2A limit: ${key}`);
    }
  }
  return limits;
};
export const responseLimit = (dimension: string): A2AInvocationError =>
  new A2AInvocationError(A2A_RESPONSE_LIMIT, "unknown", `A2A response limit exceeded: ${dimension}`);

/** Count JSON before serialization; reject cycles/exotic data and bound traversal. */
export const boundedJsonBytes = (value: unknown, maxBytes: number): number => {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (count: number): void => { bytes += count; if (bytes > maxBytes) throw responseLimit("event bytes"); };
  const string = (text: string): void => {
    add(Buffer.byteLength(text, "utf8") + 2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) add(1);
      else if (code < 32) add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 1 : 5);
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) index++;
      else if (code >= 0xd800 && code <= 0xdfff) add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw responseLimit("JSON complexity");
    if (item === null) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item !== "object") throw responseLimit("non-JSON data");
    if (ancestors.has(item)) throw responseLimit("cyclic data");
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw responseLimit("non-JSON object");
    ancestors.add(item);
    add(2);
    let count = 0;
    if (array) {
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (descriptor && !("value" in descriptor)) throw responseLimit("accessor data");
        if (count++) add(1);
        visit(descriptor?.value ?? null, depth + 1);
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in descriptor)) throw responseLimit("accessor data");
        if (descriptor.value === undefined) continue;
        if (++nodes > 100_000) throw responseLimit("JSON complexity");
        if (count++) add(1);
        string(key); add(1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return bytes;
};

export const createA2AResponseMeter = (limits: A2AResponseLimits) => {
  let events = 0, responseBytes = 0, artifacts = 0, artifactBytes = 0;
  return {
    event(value: unknown): void {
      if (++events > limits.maxEvents) throw responseLimit("event count");
      responseBytes += boundedJsonBytes(value, limits.maxEventBytes);
      if (responseBytes > limits.maxResponseBytes) throw responseLimit("total response bytes");
    },
    artifact(value: unknown): void {
      if (++artifacts > limits.maxArtifacts) throw responseLimit("artifact count");
      artifactBytes += boundedJsonBytes(value, limits.maxArtifactBytes);
      if (artifactBytes > limits.maxTotalArtifactBytes) throw responseLimit("total artifact bytes");
    },
  };
};

export const createA2ARequestScope = (upstream?: AbortSignal, timeoutMs = DEFAULT_A2A_TIMEOUT_MS) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("A2A timeout must be a positive 32-bit timer interval");
  const controller = new AbortController();
  const upstreamAbort = (): void => controller.abort(upstream?.reason instanceof A2AInvocationError
    ? upstream.reason : new DOMException("A2A invocation cancelled", "AbortError"));
  if (upstream?.aborted) upstreamAbort();
  else upstream?.addEventListener("abort", upstreamAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new A2AInvocationError(A2A_REQUEST_TIMEOUT, "unknown", "A2A request timed out")), timeoutMs);
  const check = (): void => { if (controller.signal.aborted) throw controller.signal.reason; };
  return {
    signal: controller.signal,
    check,
    abort(reason: unknown): void { controller.abort(reason); },
    run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        let listening = false;
        const detach = (): void => { if (listening) controller.signal.removeEventListener("abort", aborted); listening = false; };
        const aborted = (): void => { detach(); reject(controller.signal.reason); };
        if (controller.signal.aborted) { aborted(); return; }
        listening = true;
        controller.signal.addEventListener("abort", aborted, { once: true });
        try {
          const pending = operation();
          Promise.resolve(pending).then(value => {
            detach(); if (controller.signal.aborted) reject(controller.signal.reason); else resolve(value);
          }, error => { detach(); reject(controller.signal.aborted ? controller.signal.reason : error); });
        } catch (error) { detach(); reject(controller.signal.aborted ? controller.signal.reason : error); }
      });
    },
    dispose(): void {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", upstreamAbort);
      if (!controller.signal.aborted) controller.abort(new DOMException("A2A invocation closed", "AbortError"));
    },
  };
};
export type A2ARequestScope = ReturnType<typeof createA2ARequestScope>;

/** A noncooperative iterator cannot hold cancellation hostage. Observe late rejection. */
export const closeA2AIterator = (iterator: AsyncIterator<unknown> | undefined): void => {
  try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Preserve the invocation outcome. */ }
};

/** Bound bytes before the SDK's response.json()/SSE buffering, sharing a wire meter. */
export const createA2ABoundedFetch = (scope: A2ARequestScope, limits: A2AResponseLimits, fetchImpl: typeof fetch) => {
  let totalBytes = 0;
  return (maxBodyBytes: number): typeof fetch => async (input, init) => {
    const signal = AbortSignal.any([scope.signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]);
    const response = await scope.run(() => Promise.resolve(fetchImpl(input, { ...init, signal })).then(value => {
      if (scope.signal.aborted) { void value.body?.cancel(scope.signal.reason).catch(() => {}); throw scope.signal.reason; }
      return value;
    }));
    const reader = response.body?.getReader();
    if (!reader) return response;
    let bodyBytes = 0, closed = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = (reason?: unknown): void => {
      if (closed) return;
      closed = true;
      scope.signal.removeEventListener("abort", aborted);
      if (reason !== undefined) {
        void reader.cancel(reason).catch(() => {});
        try { streamController?.error(reason); } catch { /* Already closed. */ }
      }
      try { reader.releaseLock(); } catch { /* A noncooperative source may still be finishing. */ }
    };
    const aborted = (): void => close(scope.signal.reason);
    const fail = (): never => {
      const error = responseLimit("HTTP body bytes"); scope.abort(error); close(error); throw error;
    };
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && (length > maxBodyBytes || length > limits.maxResponseBytes - totalBytes)) fail();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; scope.signal.addEventListener("abort", aborted, { once: true }); if (scope.signal.aborted) aborted(); },
      async pull(controller) {
        try {
          const chunk = await scope.run(() => reader.read());
          if (chunk.done) { close(); controller.close(); return; }
          bodyBytes += chunk.value.byteLength; totalBytes += chunk.value.byteLength;
          if (bodyBytes > maxBodyBytes || totalBytes > limits.maxResponseBytes) fail();
          controller.enqueue(chunk.value);
        } catch (error) { close(error); }
      },
      cancel(reason) { close(reason ?? new DOMException("A2A response closed", "AbortError")); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
};
