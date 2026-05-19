import {
  AGENT_PROFILE_NOT_FOUND,
  APPROVAL_ACTION_TYPES,
  CAPABILITY_RISK_LEVELS,
  SKILL_SOURCE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isSkillSource,
  ok,
  type ApprovalActionType,
  type CapabilityRiskLevel,
  type SkillGenerationPreviewResult,
  type SkillGenerationRequest,
  type HarnessResult,
  type SkillAuthorDraft,
  type SkillAuthorPreview,
  type SkillFileProposalResult,
  type SkillProfileBindingApplyResult,
  type SkillProfileBindingProposalRequest,
  type SkillProfileBindingProposalResult,
  type SkillSource,
  type SkillSourceRefreshResult,
} from "@harness/core";
import {
  applySkillSourceBindingProposal,
  buildSkillSourceBindingProposal,
} from "@harness/agent";
import type { LocalStateService, SkillSourceRepository } from "@harness/storage";
import {
  buildGeneratedSkillDraft,
  parseSkillFrontmatter,
} from "@harness/skillify-adapter";
import { access } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

/**
 * The path-policy registry exposes a tiny "register/unregister" surface
 * so the IPC handler can keep `sourceDir` whitelist in sync with custom
 * skill roots without the handler importing the policy module directly.
 */
export interface SkillRootPolicy {
  registerSourceDir(rootDir: string): void;
  unregisterSourceDir(rootDir: string): void;
}

/**
 * Capability registry abstraction — just enough surface for `refresh`.
 * Phase 4 will wire this to the real `CapabilityRegistry` instance.
 */
export interface CapabilityRefreshable {
  refresh(source: SkillSource): Promise<SkillSourceRefreshResult>;
}

export interface SkillSourceIpcContext {
  state: LocalStateService;
  skillSources: SkillSourceRepository;
  pathPolicy: SkillRootPolicy;
  capabilityRegistry: CapabilityRefreshable;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

export const buildSkillSourceHandlers = (ctx: SkillSourceIpcContext) => {
  const { state, skillSources, pathPolicy, capabilityRegistry } = ctx;

  return {
    list: async (): Promise<HarnessResult<SkillSource[]>> =>
      wrap(() => skillSources.list()),

    add: async (input: {
      name: string;
      rootDir: string;
    }): Promise<HarnessResult<SkillSource>> => {
      if (typeof input?.name !== "string" || input.name.trim().length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "name must be non-empty"));
      }
      if (typeof input?.rootDir !== "string" || input.rootDir.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "rootDir must be non-empty"));
      }
      return wrap(async () => {
        const added = await skillSources.add({
          name: input.name.trim(),
          rootDir: input.rootDir,
        });
        // Sync with path-policy registry so a fresh invocation immediately
        // sees the new root without a restart.
        pathPolicy.registerSourceDir(added.rootDir);
        // Stamp the row so the UI badge reflects the policy state.
        return skillSources.update({
          ...added,
          registeredInPathPolicy: true,
        });
      });
    },

    update: async (input: {
      source: unknown;
    }): Promise<HarnessResult<SkillSource>> => {
      const candidate = input?.source;
      if (!isSkillSource(candidate)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "source failed SkillSource validation",
          ),
        );
      }
      const source: SkillSource = candidate;
      const existing = await skillSources.get(source.id);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${source.id}`),
        );
      }
      return wrap(() => skillSources.update(source));
    },

    remove: async (input: {
      sourceId: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.sourceId !== "string" || input.sourceId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "sourceId is required"));
      }
      const existing = await skillSources.get(input.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${input.sourceId}`),
        );
      }
      return wrap(async () => {
        await skillSources.remove(input.sourceId);
        pathPolicy.unregisterSourceDir(existing.rootDir);
      });
    },

    refresh: async (input: {
      sourceId: string;
    }): Promise<HarnessResult<SkillSourceRefreshResult>> => {
      if (typeof input?.sourceId !== "string" || input.sourceId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "sourceId is required"));
      }
      const existing = await skillSources.get(input.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${input.sourceId}`),
        );
      }
      return wrap(() => capabilityRegistry.refresh(existing));
    },

    generateSkillDraft: async (input: {
      request: unknown;
    }): Promise<HarnessResult<SkillGenerationPreviewResult>> => {
      const request = normalizeSkillGenerationRequest(input?.request);
      if (request.userIntent.trim().length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "userIntent is required"));
      }
      const existing = await skillSources.get(request.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${request.sourceId}`),
        );
      }
      return wrap(async () => {
        const draft = buildGeneratedSkillDraft(request);
        const preview = await buildSkillAuthorPreview(state, existing, draft);
        return { draft, preview };
      });
    },

    previewSkillDraft: async (input: {
      draft: unknown;
    }): Promise<HarnessResult<SkillAuthorPreview>> => {
      const draft = normalizeSkillAuthorDraft(input?.draft);
      const existing = await skillSources.get(draft.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${draft.sourceId}`),
        );
      }
      return wrap(() => buildSkillAuthorPreview(state, existing, draft));
    },

    proposeSkillFile: async (input: {
      draft: unknown;
    }): Promise<HarnessResult<SkillFileProposalResult>> => {
      const draft = normalizeSkillAuthorDraft(input?.draft);
      const existing = await skillSources.get(draft.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${draft.sourceId}`),
        );
      }
      return wrap(async () => {
        const preview = await buildSkillAuthorPreview(state, existing, draft);
        if (!preview.ok) {
          throw new Error("generated SKILL.md failed validation");
        }
        const thread = await state.createThread({
          title: `Skill authoring: ${draft.name.trim()}`,
          targetDir: existing.rootDir,
        });
        const taskRun = await state.createTaskRun({
          threadId: thread.id,
          userRequest: `Create generated SKILL.md at ${preview.relativePath}`,
          targetDir: existing.rootDir,
          status: "waiting_for_approval",
        });
        const step = await state.createStep({
          taskRunId: taskRun.id,
          index: 0,
          kind: "approval",
          title: "SKILL.md 작성 승인 대기",
          status: "pending",
          inputSummary: preview.relativePath,
        });
        await state.setTaskRunCurrentStep(taskRun.id, step.id);
        const checkpoint = await state.createCheckpoint({
          taskRunId: taskRun.id,
          stepId: step.id,
          reason: "before_edit",
          stateRef: JSON.stringify({
            sourceId: existing.id,
            rootDir: existing.rootDir,
            relativePath: preview.relativePath,
            skillSlug: draft.slug.trim(),
          }),
          summary: "before generated SKILL.md file_write approval",
        });
        const approval = await state.createApproval({
          taskRunId: taskRun.id,
          checkpointId: checkpoint.id,
          actionType: "file_write",
          actionSummary: `Create generated SKILL.md: ${preview.relativePath}`,
          status: "pending",
          proposedAction: {
            type: "file_write",
            filePatch: {
              path: preview.relativePath,
              after: preview.content,
            },
          },
        });
        return {
          threadId: thread.id,
          taskRunId: taskRun.id,
          approval,
          preview,
        };
      });
    },

    generateProfileBindingProposal: async (input: {
      request: unknown;
    }): Promise<HarnessResult<SkillProfileBindingProposalResult>> => {
      const request = normalizeProfileBindingRequest(input?.request);
      if (!request.ok) {
        return err(harnessError(STATE_INVALID_INPUT, request.reason));
      }
      const source = await skillSources.get(request.value.sourceId);
      if (!source) {
        return err(
          harnessError(
            SKILL_SOURCE_NOT_FOUND,
            `unknown source: ${request.value.sourceId}`,
          ),
        );
      }
      const profile = await state.agentProfiles.get(request.value.profileId);
      if (!profile) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `unknown profile: ${request.value.profileId}`,
          ),
        );
      }
      return ok(
        buildSkillSourceBindingProposal({
          profile,
          source,
          capabilityIds: request.value.capabilityIds ?? [],
        }),
      );
    },

    applyProfileBindingProposal: async (input: {
      request: unknown;
    }): Promise<HarnessResult<SkillProfileBindingApplyResult>> => {
      const request = normalizeProfileBindingRequest(input?.request);
      if (!request.ok) {
        return err(harnessError(STATE_INVALID_INPUT, request.reason));
      }
      const source = await skillSources.get(request.value.sourceId);
      if (!source) {
        return err(
          harnessError(
            SKILL_SOURCE_NOT_FOUND,
            `unknown source: ${request.value.sourceId}`,
          ),
        );
      }
      const profile = await state.agentProfiles.get(request.value.profileId);
      if (!profile) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `unknown profile: ${request.value.profileId}`,
          ),
        );
      }
      const proposal = buildSkillSourceBindingProposal({
        profile,
        source,
        capabilityIds: request.value.capabilityIds ?? [],
      });
      return wrap(async () => {
        const updated = await state.agentProfiles.update(
          applySkillSourceBindingProposal(profile, proposal),
        );
        return { ...proposal, profile: updated };
      });
    },
  };
};

export type SkillSourceIpcHandlers = ReturnType<typeof buildSkillSourceHandlers>;

const ACTION_SET = new Set<string>(APPROVAL_ACTION_TYPES);
const RISK_SET = new Set<string>(CAPABILITY_RISK_LEVELS);

const normalizeSkillAuthorDraft = (value: unknown): SkillAuthorDraft => {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const triggerTerms = Array.isArray(input.triggerTerms)
    ? input.triggerTerms.filter((item): item is string => typeof item === "string")
    : [];
  const allowedActions = Array.isArray(input.allowedActions)
    ? input.allowedActions.filter((item): item is ApprovalActionType =>
        typeof item === "string" && ACTION_SET.has(item),
      )
    : [];
  const risk =
    typeof input.riskLevel === "string" && RISK_SET.has(input.riskLevel)
      ? (input.riskLevel as CapabilityRiskLevel)
      : "low";
  return {
    sourceId: typeof input.sourceId === "string" ? input.sourceId : "",
    slug: typeof input.slug === "string" ? input.slug : "",
    name: typeof input.name === "string" ? input.name : "",
    description:
      typeof input.description === "string" ? input.description : "",
    triggerTerms,
    riskLevel: risk,
    allowedActions,
    body: typeof input.body === "string" ? input.body : "",
  };
};

const normalizeSkillGenerationRequest = (
  value: unknown,
): SkillGenerationRequest => {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const profileIds = Array.isArray(input.profileIds)
    ? input.profileIds.filter((item): item is string => typeof item === "string")
    : [];
  const evidenceArtifactIds = Array.isArray(input.evidenceArtifactIds)
    ? input.evidenceArtifactIds.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    sourceId: typeof input.sourceId === "string" ? input.sourceId : "",
    userIntent:
      typeof input.userIntent === "string" ? input.userIntent.trim() : "",
    profileIds,
    evidenceArtifactIds,
  };
};

const normalizeProfileBindingRequest = (
  value: unknown,
):
  | { ok: true; value: SkillProfileBindingProposalRequest }
  | { ok: false; reason: string } => {
  const input =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  if (
    typeof input.sourceId !== "string" ||
    input.sourceId.trim().length === 0
  ) {
    return { ok: false, reason: "sourceId is required" };
  }
  if (
    typeof input.profileId !== "string" ||
    input.profileId.trim().length === 0
  ) {
    return { ok: false, reason: "profileId is required" };
  }
  const capabilityIds = Array.isArray(input.capabilityIds)
    ? input.capabilityIds.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    ok: true,
    value: {
      sourceId: input.sourceId.trim(),
      profileId: input.profileId.trim(),
      capabilityIds,
    },
  };
};

const buildSkillAuthorPreview = async (
  state: LocalStateService,
  source: SkillSource,
  draft: SkillAuthorDraft,
): Promise<SkillAuthorPreview> => {
  const errors: SkillAuthorPreview["errors"] = [];
  const warnings: string[] = [];
  const slug = draft.slug.trim().toLowerCase();
  if (draft.sourceId.trim().length === 0) {
    errors.push({ field: "sourceId", message: "sourceId is required" });
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(slug)) {
    errors.push({
      field: "slug",
      message: "slug must be 2-63 chars: lowercase letters, digits, - or _",
    });
  }
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required" });
  }
  if (draft.description.trim().length === 0) {
    errors.push({ field: "description", message: "description is required" });
  }
  if (draft.triggerTerms.length === 0) {
    warnings.push("triggerTerms is empty");
  }
  if (!source.enabled) {
    warnings.push("source is disabled; refresh will not activate the skill");
  }
  if (!source.trusted) {
    warnings.push("source is untrusted; skill scripts remain blocked");
  }
  warnings.push(...contentWarnings(draft));

  const relativePath = `${slug || "skill"}/SKILL.md`;
  const absolutePath = resolve(normalize(join(source.rootDir, relativePath)));
  const absoluteRoot = resolve(normalize(source.rootDir));
  const withinSourceRoot = isWithin(absoluteRoot, absolutePath);
  if (!withinSourceRoot) {
    errors.push({ field: "slug", message: "skill path escapes source root" });
  }

  const content = renderSkillMarkdown({ ...draft, slug });
  const wouldOverwrite = withinSourceRoot
    ? await fileExists(absolutePath)
    : false;
  if (wouldOverwrite) {
    warnings.push(
      "target SKILL.md already exists; approval execution will overwrite that file",
    );
  }
  if (slug.length > 0) {
    const existingCapability = await state.getCapability(slug);
    if (existingCapability) {
      const sourceKey = capabilitySourceKey(source);
      warnings.push(
        existingCapability.source === sourceKey
          ? `capability id "${slug}" is already registered for this source and will be updated on refresh`
          : `capability id "${slug}" is already registered by ${existingCapability.source}; choose another id to avoid replacing suggestion ownership`,
      );
    }
  }
  let parsed: SkillAuthorPreview["parsed"] | undefined;
  try {
    const parsedFrontmatter = parseSkillFrontmatter({
      path: absolutePath,
      dir: dirname(absolutePath),
      content,
    });
    parsed = {
      id: parsedFrontmatter.id,
      name: parsedFrontmatter.name,
      description: parsedFrontmatter.description,
      riskLevel: parsedFrontmatter.riskLevel,
      triggerTerms: parsedFrontmatter.triggerTerms,
      allowedActions: parsedFrontmatter.allowedActions,
    };
  } catch (e) {
    errors.push({
      field: "content",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    riskyActions: [...draft.allowedActions],
    sourceId: source.id,
    relativePath,
    content,
    wouldOverwrite,
    ...(parsed ? { parsed } : {}),
  };
};

const capabilitySourceKey = (source: SkillSource): string =>
  source.origin === "project"
    ? "skillify:project"
    : source.origin === "user"
      ? "skillify:user"
      : `skillify:${source.id}`;

const renderSkillMarkdown = (draft: SkillAuthorDraft): string => {
  const body = draft.body.trim() || "Describe when and how to use this skill.";
  return [
    "---",
    `id: ${draft.slug.trim().toLowerCase()}`,
    `name: ${yamlScalar(draft.name)}`,
    `description: ${yamlScalar(draft.description)}`,
    `risk: ${draft.riskLevel}`,
    `allowedActions: ${yamlArray(draft.allowedActions)}`,
    `requiredApprovals: ${yamlArray(draft.allowedActions)}`,
    `triggerTerms: ${yamlArray(draft.triggerTerms)}`,
    "tags: []",
    "platforms: [any]",
    "---",
    "",
    `# ${draft.name.trim()}`,
    "",
    body,
    "",
  ].join("\n");
};

const FORBIDDEN_CONTENT_PATTERNS: readonly {
  pattern: RegExp;
  message: string;
}[] = [
  {
    pattern: /approval\s*(bypass|skip|우회)|승인\s*우회/i,
    message: "content appears to suggest bypassing approval",
  },
  {
    pattern: /hide\s+.*from\s+.*user|사용자에게\s*숨김|몰래/i,
    message: "content appears to hide actions from the user",
  },
  {
    pattern: /always\s+execute|무조건\s*실행|자동으로\s*실행/i,
    message: "content appears to require unconditional execution",
  },
];

const contentWarnings = (draft: SkillAuthorDraft): string[] => {
  const text = [draft.name, draft.description, draft.body].join("\n");
  const warnings: string[] = [];
  for (const rule of FORBIDDEN_CONTENT_PATTERNS) {
    if (rule.pattern.test(text)) warnings.push(rule.message);
  }
  return warnings;
};

const yamlScalar = (value: string): string =>
  `"${value.trim().replace(/[\r\n]+/g, " ").replace(/"/g, "'")}"`;

const yamlArray = (values: readonly string[]): string => {
  const cleaned = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) return "[]";
  return `[${cleaned.map(yamlScalar).join(", ")}]`;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const isWithin = (parent: string, child: string): boolean => {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
};
