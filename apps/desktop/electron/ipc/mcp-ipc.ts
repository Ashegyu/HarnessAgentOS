import {
  MCP_SERVER_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isMcpServerConfig,
  ok,
  type HarnessResult,
  type McpServerConfig,
  type McpServerHealth,
} from "@harness/core";
import type { McpServerRepository } from "@harness/storage";

/**
 * Probe contract — the IPC layer asks the host to actually contact the
 * MCP server (or not, in tests) and returns a `McpServerHealth` record.
 * Real implementation in Phase 4 will spawn the stdio command / HEAD
 * the http endpoint with a short timeout.
 */
export type McpProbe = (server: McpServerConfig) => Promise<McpServerHealth>;

export interface McpIpcContext {
  mcp: McpServerRepository;
  probe: McpProbe;
}

const validateServerInput = (
  raw: unknown,
):
  | { ok: true; value: McpServerConfig }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "server must be an object" };
  }
  const stamped = {
    id: "mcp_placeholder",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...(raw as Record<string, unknown>),
  };
  if (!isMcpServerConfig(stamped)) {
    return { ok: false, reason: "server failed McpServerConfig validation" };
  }
  return { ok: true, value: raw as McpServerConfig };
};

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

export const buildMcpHandlers = (ctx: McpIpcContext) => {
  const { mcp, probe } = ctx;
  return {
    list: async (): Promise<HarnessResult<McpServerConfig[]>> =>
      wrap(() => mcp.list()),

    upsert: async (input: {
      server: unknown;
    }): Promise<HarnessResult<McpServerConfig>> => {
      const v = validateServerInput(input?.server);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(() => mcp.upsert(v.value));
    },

    delete: async (input: {
      serverId: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.serverId !== "string" || input.serverId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "serverId is required"));
      }
      return wrap(async () => {
        await mcp.delete(input.serverId);
      });
    },

    toggle: async (input: {
      serverId: string;
      enabled: boolean;
    }): Promise<HarnessResult<McpServerConfig>> => {
      if (typeof input?.serverId !== "string" || input.serverId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "serverId is required"));
      }
      if (typeof input.enabled !== "boolean") {
        return err(harnessError(STATE_INVALID_INPUT, "enabled must be boolean"));
      }
      const existing = await mcp.get(input.serverId);
      if (!existing) {
        return err(
          harnessError(MCP_SERVER_NOT_FOUND, `unknown server: ${input.serverId}`),
        );
      }
      return wrap(() => mcp.toggle(input.serverId, input.enabled));
    },

    healthCheck: async (input: {
      serverId: string;
    }): Promise<HarnessResult<McpServerHealth>> => {
      if (typeof input?.serverId !== "string" || input.serverId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "serverId is required"));
      }
      const existing = await mcp.get(input.serverId);
      if (!existing) {
        return err(
          harnessError(MCP_SERVER_NOT_FOUND, `unknown server: ${input.serverId}`),
        );
      }
      return wrap(async () => {
        const health = await probe(existing);
        await mcp.recordHealth(input.serverId, health);
        return health;
      });
    },
  };
};

export type McpIpcHandlers = ReturnType<typeof buildMcpHandlers>;
