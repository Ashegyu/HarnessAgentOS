import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  A2AServerGatewayRequest,
  A2AServerGatewayResponse,
} from "./a2a-server-gateway.ts";

export interface A2ACompanionGateway {
  handle(request: A2AServerGatewayRequest): Promise<A2AServerGatewayResponse>;
}

export interface A2ACompanionSkill {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
}

export interface A2ACompanionCardInput {
  name: string;
  description?: string;
  protocolVersion?: string;
  version?: string;
  skills?: readonly A2ACompanionSkill[];
}

export interface A2ACompanionServerOptions {
  gateway: A2ACompanionGateway;
  card: A2ACompanionCardInput;
  host?: string;
  port?: number;
  agentCardPath?: string;
  jsonRpcPath?: string;
  maxBodyBytes?: number;
}

export interface A2ACompanionServer {
  start(): Promise<A2ACompanionRunningServer>;
}

export interface A2ACompanionRunningServer {
  baseUrl: string;
  agentCardUrl: string;
  jsonRpcUrl: string;
  close(): Promise<void>;
}

interface A2ACompanionRouteContext {
  gateway: A2ACompanionGateway;
  card: A2ACompanionCardInput;
  agentCardPath: string;
  jsonRpcPath: string;
  maxBodyBytes: number;
  urls: A2ACompanionUrls;
}

interface A2ACompanionUrls {
  baseUrl: string;
  agentCardUrl: string;
  jsonRpcUrl: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_AGENT_CARD_PATH = "/.well-known/agent-card.json";
const DEFAULT_JSON_RPC_PATH = "/a2a/jsonrpc";
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;

export const createA2ACompanionServer = (
  options: A2ACompanionServerOptions,
): A2ACompanionServer => ({
  start: () => startCompanion(options),
});

const startCompanion = (
  options: A2ACompanionServerOptions,
): Promise<A2ACompanionRunningServer> => {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const agentCardPath = normalizeRoutePath(
    options.agentCardPath ?? DEFAULT_AGENT_CARD_PATH,
  );
  const jsonRpcPath = normalizeRoutePath(options.jsonRpcPath ?? DEFAULT_JSON_RPC_PATH);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return new Promise((resolve, reject) => {
    let context: A2ACompanionRouteContext | null = null;
    const server = createServer((request, response) => {
      if (!context) {
        sendJson(response, 503, companionError("A2A_COMPANION_NOT_READY", "Server is not ready"));
        return;
      }
      void routeRequest(request, response, context);
    });

    const failStart = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", failStart);
    server.listen(port, host, () => {
      server.off("error", failStart);
      const address = server.address();
      if (!isAddressInfo(address)) {
        server.close();
        reject(new Error("A2A companion did not bind to a TCP port"));
        return;
      }

      const urls = companionUrls(host, address.port, agentCardPath, jsonRpcPath);
      context = {
        gateway: options.gateway,
        card: options.card,
        agentCardPath,
        jsonRpcPath,
        maxBodyBytes,
        urls,
      };
      resolve({
        ...urls,
        close: () => closeServer(server),
      });
    });
  });
};

const routeRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: A2ACompanionRouteContext,
): Promise<void> => {
  const path = requestPath(request);
  if (request.method === "GET" && path === context.agentCardPath) {
    sendJson(response, 200, agentCard(context.card, context.urls.jsonRpcUrl));
    return;
  }

  if (path !== context.jsonRpcPath) {
    sendJson(response, 404, companionError("A2A_COMPANION_NOT_FOUND", "Route not found"));
    return;
  }

  if (request.method !== "POST") {
    sendJson(
      response,
      405,
      companionError("A2A_COMPANION_METHOD_NOT_ALLOWED", "POST is required"),
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(request, context.maxBodyBytes));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(
        response,
        413,
        companionError("A2A_COMPANION_BODY_TOO_LARGE", "Request body is too large"),
      );
      return;
    }
    sendJson(
      response,
      400,
      companionError("A2A_COMPANION_INVALID_JSON", "Request body must be JSON"),
    );
    return;
  }

  const gatewayResponse = await context.gateway.handle({
    remoteAddress: remoteAddress(request),
    headers: headers(request),
    body,
  });
  sendJson(response, gatewayResponse.status, gatewayResponse.body);
};

const agentCard = (
  input: A2ACompanionCardInput,
  jsonRpcUrl: string,
): Record<string, unknown> => ({
  name: input.name,
  description: input.description ?? "",
  protocolVersion: input.protocolVersion ?? "0.3.0",
  version: input.version ?? "0.0.0",
  url: jsonRpcUrl,
  preferredTransport: "JSONRPC",
  skills: input.skills ?? [],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  additionalInterfaces: [{ url: jsonRpcUrl, transport: "JSONRPC" }],
});

const readBody = async (
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
};

class BodyTooLargeError extends Error {}

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
};

const companionError = (
  code: string,
  message: string,
): { jsonrpc: "2.0"; id: null; error: { code: string; message: string } } => ({
  jsonrpc: "2.0",
  id: null,
  error: { code, message },
});

const requestPath = (request: IncomingMessage): string => {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
};

const headers = (
  request: IncomingMessage,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
};

const remoteAddress = (request: IncomingMessage): string => {
  const raw = request.socket.remoteAddress;
  if (!raw) return "unknown";
  return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
};

const companionUrls = (
  host: string,
  port: number,
  agentCardPath: string,
  jsonRpcPath: string,
): A2ACompanionUrls => {
  const origin = `http://${formatHost(host)}:${port}`;
  return {
    baseUrl: origin,
    agentCardUrl: `${origin}${agentCardPath}`,
    jsonRpcUrl: `${origin}${jsonRpcPath}`,
  };
};

const formatHost = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const normalizeRoutePath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`;

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const isAddressInfo = (
  address: ReturnType<Server["address"]>,
): address is AddressInfo =>
  typeof address === "object" &&
  address !== null &&
  typeof address.port === "number";
