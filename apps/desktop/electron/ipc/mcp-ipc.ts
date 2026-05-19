import {
  MCP_SERVER_NOT_FOUND,
  AGENT_PROFILE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isMcpServerConfig,
  isMcpTransport,
  ok,
  type HarnessResult,
  type GeneratedMcpServerDraft,
  type McpServerBindingApplyResult,
  type McpServerBindingProposalRequest,
  type McpServerBindingProposalResult,
  type McpServerConfig,
  type McpServerConfigDraft,
  type McpServerDraftPreview,
  type McpServerDraftPreviewIssue,
  type McpServerGenerationPreviewResult,
  type McpServerGenerationRequest,
  type McpServerHealth,
} from "@harness/core";
import {
  applyMcpServerBindingProposal,
  buildMcpServerBindingProposal,
  buildGeneratedMcpServerDraft,
  sanitizeServerName,
} from "@harness/agent";
import type {
  AgentProfileRepository,
  McpServerRepository,
} from "@harness/storage";

/**
 * Probe contract — the IPC layer asks the host to actually contact the
 * MCP server (or not, in tests) and returns a `McpServerHealth` record.
 * Real implementation in Phase 4 will spawn the stdio command / HEAD
 * the http endpoint with a short timeout.
 */
export type McpProbe = (server: McpServerConfig) => Promise<McpServerHealth>;

export interface McpIpcContext {
  mcp: McpServerRepository;
  profiles: AgentProfileRepository;
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

const normalizeGenerationRequest = (
  raw: unknown,
):
  | { ok: true; value: McpServerGenerationRequest }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "request must be an object" };
  }
  const request = raw as Record<string, unknown>;
  const preferredTransport = request.preferredTransport;
  const profileIds = request.profileIds;
  if (
    typeof request.userIntent !== "string" ||
    request.userIntent.trim().length === 0
  ) {
    return { ok: false, reason: "request.userIntent is required" };
  }
  if (
    preferredTransport !== undefined &&
    !isMcpTransport(preferredTransport)
  ) {
    return {
      ok: false,
      reason: "request.preferredTransport must be stdio, http, or sse",
    };
  }
  if (
    profileIds !== undefined &&
    (!Array.isArray(profileIds) ||
      !profileIds.every((id) => typeof id === "string"))
  ) {
    return { ok: false, reason: "request.profileIds must be a string array" };
  }
  return {
    ok: true,
    value: {
      userIntent: request.userIntent.trim(),
      preferredTransport,
      profileIds: profileIds === undefined ? undefined : [...profileIds],
    },
  };
};

const normalizeBindingProposalRequest = (
  raw: unknown,
):
  | { ok: true; value: McpServerBindingProposalRequest }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "request must be an object" };
  }
  const request = raw as Record<string, unknown>;
  if (
    typeof request.serverId !== "string" ||
    request.serverId.trim().length === 0
  ) {
    return { ok: false, reason: "request.serverId is required" };
  }
  if (
    typeof request.profileId !== "string" ||
    request.profileId.trim().length === 0
  ) {
    return { ok: false, reason: "request.profileId is required" };
  }
  return {
    ok: true,
    value: {
      serverId: request.serverId.trim(),
      profileId: request.profileId.trim(),
    },
  };
};

const draftServerOnly = (
  draft: GeneratedMcpServerDraft,
): McpServerConfigDraft => {
  const server: McpServerConfigDraft = {
    name: draft.name,
    description: draft.description,
    transport: draft.transport,
    env: draft.env,
    envSecretRefs: draft.envSecretRefs,
    scope: draft.scope,
    enabled: draft.enabled,
  };
  if (draft.transport === "stdio") {
    server.command = draft.command;
    server.args = draft.args;
  } else {
    server.url = draft.url;
  }
  return server;
};

const hasPlaceholder = (value: string | undefined): boolean =>
  typeof value === "string" &&
  (/<[^>]+>/.test(value) || /example\.com/i.test(value));

const buildPreview = (
  draft: GeneratedMcpServerDraft,
  existing: readonly McpServerConfig[],
): McpServerDraftPreview => {
  const server = draftServerOnly(draft);
  const errors: McpServerDraftPreviewIssue[] = [];
  const warnings: string[] = [
    "Codex MCP config delivery is not enabled; this draft only targets the Claude MCP config boundary.",
  ];

  const stamped = {
    id: "mcp_preview",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...server,
  };
  if (!isMcpServerConfig(stamped)) {
    errors.push({
      field: "content",
      message: "generated server failed McpServerConfig validation",
    });
  }

  const sanitizedConfigKey = sanitizeServerName(server.name);
  const existingKeys = new Set(existing.map((s) => sanitizeServerName(s.name)));
  const wouldNameCollide = existingKeys.has(sanitizedConfigKey);
  if (wouldNameCollide) {
    warnings.push(
      `Sanitized Claude MCP config key "${sanitizedConfigKey}" already exists; save with a different name to avoid suffix allocation.`,
    );
  }

  if (server.transport === "stdio") {
    if (hasPlaceholder(server.command)) {
      warnings.push(
        "Replace the placeholder command before enabling this server.",
      );
    }
    if ((server.args ?? []).some(hasPlaceholder)) {
      warnings.push(
        "Replace placeholder args such as <allowed-root> before enabling this server.",
      );
    }
  } else if (hasPlaceholder(server.url)) {
    warnings.push("Replace the example URL before enabling this server.");
  }

  const secretRefs = Object.values(server.envSecretRefs);
  if (secretRefs.length > 0) {
    warnings.push(
      `Create matching Secret Vault keys before health check: ${secretRefs.join(", ")}.`,
    );
  }
  if (!server.enabled) {
    warnings.push(
      "Generated drafts start disabled; enable only after save and health check.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    server,
    wouldNameCollide,
    sanitizedConfigKey,
  };
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
  const { mcp, probe, profiles } = ctx;
  return {
    list: async (): Promise<HarnessResult<McpServerConfig[]>> =>
      wrap(() => mcp.list()),

    generateServerDraft: async (input: {
      request: unknown;
    }): Promise<HarnessResult<McpServerGenerationPreviewResult>> => {
      const v = normalizeGenerationRequest(input?.request);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(async () => {
        const existing = await mcp.list();
        const draft = buildGeneratedMcpServerDraft(v.value);
        return {
          draft,
          preview: buildPreview(draft, existing),
        };
      });
    },

    generateProfileBindingProposal: async (input: {
      request: unknown;
    }): Promise<HarnessResult<McpServerBindingProposalResult>> => {
      const v = normalizeBindingProposalRequest(input?.request);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      const server = await mcp.get(v.value.serverId);
      if (!server) {
        return err(
          harnessError(
            MCP_SERVER_NOT_FOUND,
            `unknown server: ${v.value.serverId}`,
          ),
        );
      }
      const profile = await profiles.get(v.value.profileId);
      if (!profile) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `unknown profile: ${v.value.profileId}`,
          ),
        );
      }
      return ok(buildMcpServerBindingProposal({ profile, server }));
    },

    applyProfileBindingProposal: async (input: {
      request: unknown;
    }): Promise<HarnessResult<McpServerBindingApplyResult>> => {
      const v = normalizeBindingProposalRequest(input?.request);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      const server = await mcp.get(v.value.serverId);
      if (!server) {
        return err(
          harnessError(
            MCP_SERVER_NOT_FOUND,
            `unknown server: ${v.value.serverId}`,
          ),
        );
      }
      const profile = await profiles.get(v.value.profileId);
      if (!profile) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `unknown profile: ${v.value.profileId}`,
          ),
        );
      }
      const proposal = buildMcpServerBindingProposal({ profile, server });
      return wrap(async () => {
        const updated = await profiles.update(
          applyMcpServerBindingProposal(profile, proposal),
        );
        return { ...proposal, profile: updated };
      });
    },

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
