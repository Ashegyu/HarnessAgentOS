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
  type GeneratedFileProposal,
  type GeneratedMcpServerDraft,
  type GeneratedMcpServerScaffoldDraft,
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
  type McpServerScaffoldGenerationRequest,
  type McpServerScaffoldPreview,
  type McpServerScaffoldPreviewIssue,
  type McpServerScaffoldPreviewResult,
  type McpServerScaffoldProposalResult,
} from "@harness/core";
import {
  applyMcpServerBindingProposal,
  buildGeneratedMcpServerScaffoldDraft,
  buildMcpServerBindingProposal,
  buildGeneratedMcpServerDraft,
  sanitizeServerName,
} from "@harness/agent";
import type {
  AgentProfileRepository,
  LocalStateService,
  McpServerRepository,
} from "@harness/storage";
import { isAbsolute } from "node:path";

/**
 * Probe contract — the IPC layer asks the host to actually contact the
 * MCP server (or not, in tests) and returns a `McpServerHealth` record.
 * Real implementation in Phase 4 will spawn the stdio command / HEAD
 * the http endpoint with a short timeout.
 */
export type McpProbe = (server: McpServerConfig) => Promise<McpServerHealth>;

export interface McpIpcContext {
  state: LocalStateService;
  mcp: McpServerRepository;
  profiles: AgentProfileRepository;
  probe: McpProbe;
  listSecretKeys?: () => Promise<readonly string[]>;
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

const normalizeScaffoldRequest = (
  raw: unknown,
):
  | { ok: true; value: McpServerScaffoldGenerationRequest }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "request must be an object" };
  }
  const request = raw as Record<string, unknown>;
  if (
    typeof request.userIntent !== "string" ||
    request.userIntent.trim().length === 0
  ) {
    return { ok: false, reason: "request.userIntent is required" };
  }
  if (
    typeof request.targetDir !== "string" ||
    request.targetDir.trim().length === 0
  ) {
    return { ok: false, reason: "request.targetDir is required" };
  }
  if (!isAbsolute(request.targetDir)) {
    return { ok: false, reason: "request.targetDir must be absolute" };
  }
  if (request.slug !== undefined && typeof request.slug !== "string") {
    return { ok: false, reason: "request.slug must be a string" };
  }
  return {
    ok: true,
    value: {
      userIntent: request.userIntent.trim(),
      targetDir: request.targetDir.trim(),
      ...(request.slug ? { slug: request.slug.trim() } : {}),
    },
  };
};

const normalizeScaffoldDraft = (
  raw: unknown,
):
  | { ok: true; value: GeneratedMcpServerScaffoldDraft }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "draft must be an object" };
  }
  const draft = raw as Record<string, unknown>;
  if (typeof draft.name !== "string" || draft.name.trim().length === 0) {
    return { ok: false, reason: "draft.name is required" };
  }
  if (typeof draft.slug !== "string" || draft.slug.trim().length === 0) {
    return { ok: false, reason: "draft.slug is required" };
  }
  if (
    typeof draft.targetDir !== "string" ||
    draft.targetDir.trim().length === 0 ||
    !isAbsolute(draft.targetDir)
  ) {
    return { ok: false, reason: "draft.targetDir must be absolute" };
  }
  if (!Array.isArray(draft.files) || draft.files.length === 0) {
    return { ok: false, reason: "draft.files must be a non-empty array" };
  }
  const files: GeneratedFileProposal[] = [];
  for (const file of draft.files) {
    if (typeof file !== "object" || file === null) {
      return { ok: false, reason: "draft.files entries must be objects" };
    }
    const f = file as Record<string, unknown>;
    if (typeof f.path !== "string" || typeof f.content !== "string") {
      return { ok: false, reason: "draft.files path/content are required" };
    }
    const riskLevel: GeneratedFileProposal["riskLevel"] =
      f.riskLevel === "medium" || f.riskLevel === "high"
        ? f.riskLevel
        : "low";
    files.push({
      path: f.path,
      content: f.content,
      rationale: typeof f.rationale === "string" ? f.rationale : "",
      riskLevel,
    });
  }
  return {
    ok: true,
    value: {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      targetDir: draft.targetDir.trim(),
      files,
      recommendedCommand:
        typeof draft.recommendedCommand === "string"
          ? draft.recommendedCommand
          : "",
      rationale: typeof draft.rationale === "string" ? draft.rationale : "",
      warnings: Array.isArray(draft.warnings)
        ? draft.warnings.filter((item): item is string => typeof item === "string")
        : [],
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

const isSafeRelativeFilePath = (value: string): boolean => {
  if (value.length === 0 || isAbsolute(value)) return false;
  if (value.includes("\\") || value.split("/").includes("..")) return false;
  return /^([a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(value);
};

const buildScaffoldPreview = (
  draft: GeneratedMcpServerScaffoldDraft,
): McpServerScaffoldPreview => {
  const errors: McpServerScaffoldPreviewIssue[] = [];
  const warnings = [...draft.warnings];
  if (!isAbsolute(draft.targetDir)) {
    errors.push({
      field: "targetDir",
      message: "targetDir must be absolute",
    });
  }
  if (draft.files.length === 0) {
    errors.push({ field: "files", message: "at least one file is required" });
  }
  for (const file of draft.files) {
    if (!isSafeRelativeFilePath(file.path)) {
      errors.push({
        field: "files",
        message: `unsafe relative file path: ${file.path}`,
      });
    }
    if (file.content.length === 0) {
      errors.push({
        field: "content",
        message: `empty generated file content: ${file.path}`,
      });
    }
    if (file.path.endsWith("src/index.ts") && /console\.log/.test(file.content)) {
      errors.push({
        field: "content",
        message: "stdio MCP server source must not write normal logs to stdout",
      });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    files: draft.files,
    smokeTestCommand: `cd ${draft.slug} && npm test && npm run build`,
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

const missingSecretRefs = async (
  server: McpServerConfig,
  listSecretKeys?: () => Promise<readonly string[]>,
): Promise<string[]> => {
  const required = Object.values(server.envSecretRefs)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (required.length === 0) return [];
  const available = new Set(await (listSecretKeys?.() ?? Promise.resolve([])));
  return required.filter((key) => !available.has(key));
};

const missingSecretError = (
  server: McpServerConfig,
  missing: readonly string[],
): HarnessResult<never> =>
  err(
    harnessError(
      STATE_INVALID_INPUT,
      `MCP server "${server.name}" references missing Secret Vault key(s): ${missing.join(", ")}`,
    ),
  );

export const buildMcpHandlers = (ctx: McpIpcContext) => {
  const { state, mcp, probe, profiles, listSecretKeys } = ctx;
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

    generateServerScaffoldDraft: async (input: {
      request: unknown;
    }): Promise<HarnessResult<McpServerScaffoldPreviewResult>> => {
      const v = normalizeScaffoldRequest(input?.request);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(async () => {
        const draft = buildGeneratedMcpServerScaffoldDraft(v.value);
        return {
          draft,
          preview: buildScaffoldPreview(draft),
        };
      });
    },

    proposeServerScaffold: async (input: {
      draft: unknown;
    }): Promise<HarnessResult<McpServerScaffoldProposalResult>> => {
      const v = normalizeScaffoldDraft(input?.draft);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(async () => {
        const preview = buildScaffoldPreview(v.value);
        if (!preview.ok) {
          throw new Error("generated MCP scaffold failed validation");
        }
        const thread = await state.createThread({
          title: `MCP scaffold: ${v.value.name}`,
          targetDir: v.value.targetDir,
        });
        const taskRun = await state.createTaskRun({
          threadId: thread.id,
          userRequest: `Create generated MCP scaffold: ${v.value.slug}`,
          targetDir: v.value.targetDir,
          status: "waiting_for_approval",
        });
        const step = await state.createStep({
          taskRunId: taskRun.id,
          index: 0,
          kind: "approval",
          title: "MCP scaffold 파일 작성 승인 대기",
          status: "pending",
          inputSummary: v.value.slug,
        });
        await state.setTaskRunCurrentStep(taskRun.id, step.id);
        const checkpoint = await state.createCheckpoint({
          taskRunId: taskRun.id,
          stepId: step.id,
          reason: "before_edit",
          stateRef: JSON.stringify({
            targetDir: v.value.targetDir,
            slug: v.value.slug,
            fileCount: v.value.files.length,
          }),
          summary: "before generated MCP scaffold file_write approvals",
        });
        const approvals = [];
        for (const file of v.value.files) {
          approvals.push(
            await state.createApproval({
              taskRunId: taskRun.id,
              checkpointId: checkpoint.id,
              actionType: "file_write",
              actionSummary: `Create MCP scaffold file: ${file.path}`,
              status: "pending",
              proposedAction: {
                type: "file_write",
                filePatch: {
                  path: file.path,
                  after: file.content,
                },
              },
            }),
          );
        }
        return {
          threadId: thread.id,
          taskRunId: taskRun.id,
          approvals,
          preview,
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
      if (v.value.enabled) {
        const missing = await missingSecretRefs(v.value, listSecretKeys);
        if (missing.length > 0) return missingSecretError(v.value, missing);
      }
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
      if (input.enabled) {
        const missing = await missingSecretRefs(existing, listSecretKeys);
        if (missing.length > 0) return missingSecretError(existing, missing);
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
      const missing = await missingSecretRefs(existing, listSecretKeys);
      if (missing.length > 0) return missingSecretError(existing, missing);
      return wrap(async () => {
        const health = await probe(existing);
        await mcp.recordHealth(input.serverId, health);
        return health;
      });
    },
  };
};

export type McpIpcHandlers = ReturnType<typeof buildMcpHandlers>;
