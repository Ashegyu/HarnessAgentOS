import { resolve, sep } from "node:path";

export interface A2AServerGatewayRequest {
  remoteAddress?: string;
  headers?: Record<string, string | undefined>;
  body: unknown;
}

export interface A2AServerGatewayResponse {
  status: number;
  body: {
    jsonrpc?: "2.0";
    id?: string | number | null;
    result?: unknown;
    error?: {
      code: string;
      message: string;
    };
  };
}

export interface A2AServerGatewayAuditEvent {
  at: string;
  decision: "accepted" | "denied";
  reason:
    | "accepted"
    | "disabled"
    | "unauthorized"
    | "rate_limited"
    | "workspace_denied"
    | "invalid_request";
  remoteAddress: string;
  requestId?: string | number | null;
  method?: string;
  taskId?: string;
  targetDir?: string;
}

export interface A2AServerMessageInput {
  taskId: string;
  message: string;
  targetDir: string;
  requestId?: string | number | null;
  remoteAddress: string;
}

export interface A2AServerMessageResult {
  text: string;
  state: "submitted" | "working" | "input-required" | "auth-required" | "completed";
}

export interface A2AServerRateLimiter {
  allow(key: string): boolean;
}

export interface A2AServerGatewayOptions {
  /** Defaults to false. External companion processes must opt in explicitly. */
  enabled?: () => boolean;
  expectedBearerToken?: () => string | null | undefined;
  allowedWorkspaceRoots: readonly string[];
  rateLimiter?: A2AServerRateLimiter;
  audit: (event: A2AServerGatewayAuditEvent) => void | Promise<void>;
  handleMessage: (
    input: A2AServerMessageInput,
  ) => Promise<A2AServerMessageResult>;
  now?: () => string;
  createTaskId?: () => string;
}

export interface InMemoryRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  nowMs?: () => number;
}

export const createInMemoryRateLimiter = (
  options: InMemoryRateLimiterOptions,
): A2AServerRateLimiter => {
  const nowMs = options.nowMs ?? (() => Date.now());
  const buckets = new Map<string, { windowStart: number; count: number }>();
  return {
    allow(key) {
      const now = nowMs();
      const existing = buckets.get(key);
      if (!existing || now - existing.windowStart >= options.windowMs) {
        buckets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (existing.count >= options.maxRequests) return false;
      existing.count += 1;
      return true;
    },
  };
};

export const createA2AServerGateway = (
  options: A2AServerGatewayOptions,
): { handle(request: A2AServerGatewayRequest): Promise<A2AServerGatewayResponse> } => {
  const enabled = options.enabled ?? (() => false);
  const now = options.now ?? (() => new Date().toISOString());
  const createTaskId =
    options.createTaskId ?? (() => `a2a_task_${Date.now().toString(36)}`);
  const roots = options.allowedWorkspaceRoots.map(normalizePath);

  const deny = async (
    request: A2AServerGatewayRequest,
    reason: A2AServerGatewayAuditEvent["reason"],
    status: number,
    code: string,
    message: string,
    parsed?: ParsedEnvelope,
  ): Promise<A2AServerGatewayResponse> => {
    await options.audit({
      at: now(),
      decision: "denied",
      reason,
      remoteAddress: remoteAddress(request),
      requestId: parsed?.id,
      method: parsed?.method,
      targetDir: parsed?.targetDir,
    });
    return errorResponse(status, code, message, parsed?.id);
  };

  return {
    async handle(request) {
      const parsed = parseEnvelope(request.body);
      if (!enabled()) {
        return deny(
          request,
          "disabled",
          404,
          "A2A_SERVER_DISABLED",
          "A2A server gateway is disabled",
          parsed,
        );
      }

      if (!authorized(request.headers, options.expectedBearerToken?.())) {
        return deny(
          request,
          "unauthorized",
          401,
          "A2A_SERVER_UNAUTHORIZED",
          "Bearer token is required",
          parsed,
        );
      }

      const rateKey = remoteAddress(request);
      if (options.rateLimiter && !options.rateLimiter.allow(rateKey)) {
        return deny(
          request,
          "rate_limited",
          429,
          "A2A_SERVER_RATE_LIMITED",
          "Rate limit exceeded",
          parsed,
        );
      }

      if (!parsed.ok) {
        return deny(
          request,
          "invalid_request",
          400,
          "A2A_SERVER_INVALID_REQUEST",
          parsed.error,
          parsed,
        );
      }

      if (parsed.method !== "message/send") {
        return deny(
          request,
          "invalid_request",
          400,
          "A2A_SERVER_UNSUPPORTED_METHOD",
          `Unsupported A2A method: ${parsed.method}`,
          parsed,
        );
      }

      if (!withinAllowedRoot(parsed.targetDir, roots)) {
        return deny(
          request,
          "workspace_denied",
          403,
          "A2A_SERVER_WORKSPACE_DENIED",
          "targetDir is outside allowed workspace roots",
          parsed,
        );
      }

      const taskId = createTaskId();
      await options.audit({
        at: now(),
        decision: "accepted",
        reason: "accepted",
        remoteAddress: remoteAddress(request),
        requestId: parsed.id,
        method: parsed.method,
        taskId,
        targetDir: parsed.targetDir,
      });
      const result = await options.handleMessage({
        taskId,
        message: parsed.message,
        targetDir: parsed.targetDir,
        requestId: parsed.id,
        remoteAddress: remoteAddress(request),
      });

      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            kind: "task",
            id: taskId,
            status: {
              state: result.state,
              message: {
                kind: "message",
                role: "agent",
                parts: [{ kind: "text", text: result.text }],
              },
            },
          },
        },
      };
    },
  };
};

type ParsedEnvelope =
  | {
      ok: true;
      id: string | number | null;
      method: string;
      message: string;
      targetDir: string;
    }
  | {
      ok: false;
      id?: string | number | null;
      method?: string;
      targetDir?: string;
      error: string;
    };

const parseEnvelope = (body: unknown): ParsedEnvelope => {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };
  const id = requestId(body.id);
  const method = typeof body.method === "string" ? body.method : undefined;
  if (!method) return { ok: false, id, error: "method must be a string" };
  const params = isRecord(body.params) ? body.params : undefined;
  if (!params) return { ok: false, id, method, error: "params must be an object" };
  const metadata = isRecord(params.metadata) ? params.metadata : undefined;
  const targetDir =
    typeof metadata?.targetDir === "string"
      ? normalizePath(metadata.targetDir)
      : undefined;
  if (!targetDir) {
    return { ok: false, id, method, error: "metadata.targetDir is required" };
  }
  const message = isRecord(params.message) ? params.message : undefined;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts
    .filter((part): part is { kind: string; text: string } =>
      isRecord(part) && part.kind === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (text.length === 0) {
    return { ok: false, id, method, targetDir, error: "message text is required" };
  }
  return { ok: true, id, method, message: text, targetDir };
};

const requestId = (id: unknown): string | number | null =>
  typeof id === "string" || typeof id === "number" || id === null ? id : null;

const authorized = (
  headers: Record<string, string | undefined> | undefined,
  expectedToken: string | null | undefined,
): boolean => {
  if (!expectedToken) return false;
  const raw = header(headers, "authorization");
  return raw === `Bearer ${expectedToken}`;
};

const header = (
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
};

const withinAllowedRoot = (
  targetDir: string | undefined,
  roots: readonly string[],
): boolean => {
  if (!targetDir) return false;
  const target = comparablePath(targetDir);
  return roots.some((root) => {
    const base = comparablePath(root);
    return target === base || target.startsWith(`${base}${sep}`);
  });
};

const normalizePath = (path: string): string => resolve(path);

const comparablePath = (path: string): string =>
  process.platform === "win32" ? normalizePath(path).toLowerCase() : normalizePath(path);

const remoteAddress = (request: A2AServerGatewayRequest): string =>
  request.remoteAddress ?? "unknown";

const errorResponse = (
  status: number,
  code: string,
  message: string,
  id?: string | number | null,
): A2AServerGatewayResponse => ({
  status,
  body: {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
