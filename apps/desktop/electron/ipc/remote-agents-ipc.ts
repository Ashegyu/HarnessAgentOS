import {
  A2A_ENDPOINT_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isA2AAgentCardSnapshot,
  isA2AEndpoint,
  isA2AEndpointDraft,
  ok,
  type A2AAgentCardSnapshot,
  type A2AEndpoint,
  type A2ARegistryEntry,
  type HarnessResult,
} from "@harness/core";
import type {
  A2ARemoteAgentRepository,
  CreateA2AEndpointInput,
} from "@harness/storage";

export interface RemoteAgentsIpcContext {
  remoteAgents: A2ARemoteAgentRepository;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

const validateEndpointInput = (
  raw: unknown,
):
  | { ok: true; value: A2AEndpoint | CreateA2AEndpointInput }
  | { ok: false; reason: string } => {
  if (isA2AEndpoint(raw)) return { ok: true, value: raw };
  if (isA2AEndpointDraft(raw)) return { ok: true, value: raw };
  return {
    ok: false,
    reason: "endpoint failed A2AEndpoint validation",
  };
};

const getEntry = async (
  remoteAgents: A2ARemoteAgentRepository,
  endpoint: A2AEndpoint,
): Promise<A2ARegistryEntry> => {
  const card = await remoteAgents.getCardSnapshot(endpoint.id);
  return card ? { endpoint, card } : { endpoint };
};

export const buildRemoteAgentsHandlers = (ctx: RemoteAgentsIpcContext) => {
  const { remoteAgents } = ctx;
  return {
    list: async (): Promise<HarnessResult<A2ARegistryEntry[]>> =>
      wrap(async () => {
        const endpoints = await remoteAgents.listEndpoints();
        return Promise.all(endpoints.map((endpoint) => getEntry(remoteAgents, endpoint)));
      }),

    get: async (input: {
      endpointId: string;
    }): Promise<HarnessResult<A2ARegistryEntry>> => {
      if (typeof input?.endpointId !== "string" || input.endpointId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "endpointId is required"));
      }
      const endpoint = await remoteAgents.getEndpoint(input.endpointId);
      if (!endpoint) {
        return err(
          harnessError(
            A2A_ENDPOINT_NOT_FOUND,
            `unknown A2A endpoint: ${input.endpointId}`,
          ),
        );
      }
      return wrap(() => getEntry(remoteAgents, endpoint));
    },

    upsertEndpoint: async (input: {
      endpoint: unknown;
    }): Promise<HarnessResult<A2AEndpoint>> => {
      const v = validateEndpointInput(input?.endpoint);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(() => remoteAgents.upsertEndpoint(v.value));
    },

    delete: async (input: {
      endpointId: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.endpointId !== "string" || input.endpointId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "endpointId is required"));
      }
      return wrap(async () => {
        await remoteAgents.deleteEndpoint(input.endpointId);
      });
    },

    toggle: async (input: {
      endpointId: string;
      enabled: boolean;
    }): Promise<HarnessResult<A2AEndpoint>> => {
      if (typeof input?.endpointId !== "string" || input.endpointId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "endpointId is required"));
      }
      if (typeof input.enabled !== "boolean") {
        return err(harnessError(STATE_INVALID_INPUT, "enabled must be boolean"));
      }
      const existing = await remoteAgents.getEndpoint(input.endpointId);
      if (!existing) {
        return err(
          harnessError(
            A2A_ENDPOINT_NOT_FOUND,
            `unknown A2A endpoint: ${input.endpointId}`,
          ),
        );
      }
      return wrap(() => remoteAgents.toggleEndpoint(input.endpointId, input.enabled));
    },

    upsertCardSnapshot: async (input: {
      snapshot: unknown;
    }): Promise<HarnessResult<A2AAgentCardSnapshot>> => {
      const snapshot = input?.snapshot;
      if (!isA2AAgentCardSnapshot(snapshot)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "snapshot failed A2AAgentCardSnapshot validation",
          ),
        );
      }
      const endpoint = await remoteAgents.getEndpoint(snapshot.endpointId);
      if (!endpoint) {
        return err(
          harnessError(
            A2A_ENDPOINT_NOT_FOUND,
            `unknown A2A endpoint: ${snapshot.endpointId}`,
          ),
        );
      }
      return wrap(() => remoteAgents.upsertCardSnapshot(snapshot));
    },
  };
};

export type RemoteAgentsIpcHandlers = ReturnType<
  typeof buildRemoteAgentsHandlers
>;
