import type {
  AgentPermissions,
  AgentProfile,
  ApprovalActionType,
} from "@harness/core";
import {
  APPROVAL_ACTION_TYPES,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_AGENT_PERMISSIONS,
} from "@harness/core";

/**
 * Form state for the AgentProfile editor. Kept distinct from the saved
 * AgentProfile shape so:
 *  1. number-typed fields can hold the in-progress string the user is typing
 *  2. unsaved drafts are checkpointable (dirty flag, validation reports)
 *  3. tests don't have to mock IPC to exercise reducer logic
 *
 * The form serializes to either CreateAgentProfileInput (new row) or the
 * full AgentProfile (existing row) on save.
 */
export interface ProfileDraft {
  id: string | null; // null = brand-new draft, not yet persisted
  name: string;
  description: string;
  category: string;
  tagsText: string;
  provider: AgentProfile["provider"];
  role: AgentProfile["role"];
  persona: string;
  model: string;
  /** UI uses strings so the user can type partial numbers. */
  temperatureText: string;
  maxTokensText: string;
  timeoutMsText: string;
  stallTimeoutMsText: string;
  contextDepthText: string;
  systemPromptPrefix: string;
  systemPromptSuffix: string;
  /** Per action type: "default" (follow global), "auto", "block". */
  permissionMap: Record<ApprovalActionType, PermissionMode>;
  perInvocationUsdText: string;
  perTaskRunUsdText: string;
  perDayUsdText: string;
  cliPathOverride: string;
  isDefault: boolean;
}

export type PermissionMode = "default" | "auto" | "block";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "auto",
  "block",
];

const numToText = (n: number | undefined): string =>
  n === undefined ? "" : String(n);

const textToNumOrUndefined = (s: string): number | undefined => {
  const trimmed = s.trim();
  if (trimmed.length === 0) return undefined;
  const v = Number(trimmed);
  return Number.isFinite(v) ? v : undefined;
};

const permissionMapFromProfile = (
  perms: AgentPermissions,
): Record<ApprovalActionType, PermissionMode> => {
  const map = {} as Record<ApprovalActionType, PermissionMode>;
  for (const t of APPROVAL_ACTION_TYPES) {
    if (perms.blockedActions.includes(t)) map[t] = "block";
    else if (perms.autoApproveActions.includes(t)) map[t] = "auto";
    else map[t] = "default";
  }
  return map;
};

const blankPermissionMap = (): Record<ApprovalActionType, PermissionMode> => {
  const map = {} as Record<ApprovalActionType, PermissionMode>;
  for (const t of APPROVAL_ACTION_TYPES) map[t] = "default";
  return map;
};

export const emptyDraft = (): ProfileDraft => ({
  id: null,
  name: "",
  description: "",
  category: "core",
  tagsText: "",
  provider: "auto",
  role: "coder",
  persona: "",
  model: "",
  temperatureText: "",
  maxTokensText: "",
  timeoutMsText: String(DEFAULT_AGENT_TIMEOUT_MS),
  stallTimeoutMsText: String(DEFAULT_AGENT_STALL_TIMEOUT_MS),
  contextDepthText: "5",
  systemPromptPrefix: "",
  systemPromptSuffix: "",
  permissionMap: blankPermissionMap(),
  perInvocationUsdText: "",
  perTaskRunUsdText: "",
  perDayUsdText: "",
  cliPathOverride: "",
  isDefault: false,
});

export const draftFromProfile = (p: AgentProfile): ProfileDraft => ({
  id: p.id,
  name: p.name,
  description: p.description,
  category: p.category,
  tagsText: p.tags.join(", "),
  provider: p.provider,
  role: p.role,
  persona: p.persona,
  model: p.tuning.model,
  temperatureText: numToText(p.tuning.temperature),
  maxTokensText: numToText(p.tuning.maxTokens),
  timeoutMsText: numToText(p.tuning.timeoutMs),
  stallTimeoutMsText: numToText(p.tuning.stallTimeoutMs),
  contextDepthText: numToText(p.tuning.contextDepth),
  systemPromptPrefix: p.tuning.systemPromptPrefix,
  systemPromptSuffix: p.tuning.systemPromptSuffix,
  permissionMap: permissionMapFromProfile(p.permissions),
  perInvocationUsdText: numToText(p.permissions.budget?.perInvocationUsd),
  perTaskRunUsdText: numToText(p.permissions.budget?.perTaskRunUsd),
  perDayUsdText: numToText(p.permissions.budget?.perDayUsd),
  cliPathOverride: p.cli.cliPathOverride,
  isDefault: p.isDefault,
});

export interface DraftValidationError {
  field: keyof ProfileDraft;
  message: string;
}

export const validateDraft = (
  draft: ProfileDraft,
): DraftValidationError[] => {
  const errors: DraftValidationError[] = [];
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  if (draft.category.trim().length === 0) {
    errors.push({ field: "category", message: "Category는 필수입니다" });
  }
  const timeout = textToNumOrUndefined(draft.timeoutMsText);
  if (timeout === undefined || timeout <= 0) {
    errors.push({
      field: "timeoutMsText",
      message: "Timeout은 양수여야 합니다",
    });
  }
  const stall = textToNumOrUndefined(draft.stallTimeoutMsText);
  if (stall === undefined || stall <= 0) {
    errors.push({
      field: "stallTimeoutMsText",
      message: "Stall timeout은 양수여야 합니다",
    });
  }
  const ctx = textToNumOrUndefined(draft.contextDepthText);
  if (ctx === undefined || !Number.isInteger(ctx) || ctx < 1) {
    errors.push({
      field: "contextDepthText",
      message: "Context depth는 1 이상의 정수여야 합니다",
    });
  }
  if (draft.temperatureText.trim().length > 0) {
    const t = textToNumOrUndefined(draft.temperatureText);
    if (t === undefined || t < 0 || t > 2) {
      errors.push({
        field: "temperatureText",
        message: "Temperature는 0–2 사이여야 합니다",
      });
    }
  }
  if (draft.maxTokensText.trim().length > 0) {
    const m = textToNumOrUndefined(draft.maxTokensText);
    if (m === undefined || !Number.isInteger(m) || m <= 0) {
      errors.push({
        field: "maxTokensText",
        message: "Max tokens는 양의 정수여야 합니다",
      });
    }
  }
  for (const [field, label] of [
    ["perInvocationUsdText", "Per-invocation budget"],
    ["perTaskRunUsdText", "Per-TaskRun budget"],
    ["perDayUsdText", "Daily budget"],
  ] as const) {
    const raw = draft[field].trim();
    if (raw.length === 0) continue;
    const v = textToNumOrUndefined(raw);
    if (v === undefined || v < 0) {
      errors.push({
        field,
        message: `${label}은 0 이상의 숫자여야 합니다`,
      });
    }
  }
  return errors;
};

/**
 * Serialize the draft into the shape `agents.create` / `agents.update`
 * expects. Callers should run `validateDraft` first; this helper assumes
 * the draft is already valid.
 */
export const serializeDraft = (
  draft: ProfileDraft,
): Omit<AgentProfile, "createdAt" | "updatedAt"> => {
  const tuning: AgentProfile["tuning"] = {
    model: draft.model,
    timeoutMs:
      textToNumOrUndefined(draft.timeoutMsText) ?? DEFAULT_AGENT_TIMEOUT_MS,
    stallTimeoutMs:
      textToNumOrUndefined(draft.stallTimeoutMsText) ??
      DEFAULT_AGENT_STALL_TIMEOUT_MS,
    contextDepth: textToNumOrUndefined(draft.contextDepthText) ?? 5,
    systemPromptPrefix: draft.systemPromptPrefix,
    systemPromptSuffix: draft.systemPromptSuffix,
  };
  const temp = textToNumOrUndefined(draft.temperatureText);
  if (temp !== undefined) tuning.temperature = temp;
  const max = textToNumOrUndefined(draft.maxTokensText);
  if (max !== undefined) tuning.maxTokens = max;

  const auto: ApprovalActionType[] = [];
  const block: ApprovalActionType[] = [];
  for (const t of APPROVAL_ACTION_TYPES) {
    if (draft.permissionMap[t] === "auto") auto.push(t);
    else if (draft.permissionMap[t] === "block") block.push(t);
  }
  const budget = budgetFromDraft(draft);
  const permissions: AgentPermissions = {
    autoApproveActions: auto,
    blockedActions: block,
    allowedSkillIds: [...DEFAULT_AGENT_PERMISSIONS.allowedSkillIds],
    toolAllowlist: [...DEFAULT_AGENT_PERMISSIONS.toolAllowlist],
    toolDenylist: [...DEFAULT_AGENT_PERMISSIONS.toolDenylist],
    ...(budget ? { budget } : {}),
  };
  return {
    // For new drafts the IPC layer ignores `id` and assigns one; for
    // existing drafts the id must carry through so update() finds the row.
    id: draft.id ?? "ap_placeholder",
    name: draft.name.trim(),
    description: draft.description,
    category: draft.category.trim().toLowerCase(),
    tags: parseTags(draft.tagsText),
    provider: draft.provider,
    role: draft.role,
    persona: draft.persona,
    tuning,
    cli: {
      cliPathOverride: draft.cliPathOverride,
      env: {},
      envSecretRefs: {},
    },
    permissions,
    mcpServerIds: [],
    skillSourceIds: [],
    isDefault: draft.isDefault,
  };
};

const budgetFromDraft = (
  draft: ProfileDraft,
): AgentPermissions["budget"] | undefined => {
  const budget: NonNullable<AgentPermissions["budget"]> = {};
  const perInvocation = textToNumOrUndefined(draft.perInvocationUsdText);
  const perTaskRun = textToNumOrUndefined(draft.perTaskRunUsdText);
  const perDay = textToNumOrUndefined(draft.perDayUsdText);
  if (draft.perInvocationUsdText.trim().length > 0 && perInvocation !== undefined) {
    budget.perInvocationUsd = perInvocation;
  }
  if (draft.perTaskRunUsdText.trim().length > 0 && perTaskRun !== undefined) {
    budget.perTaskRunUsd = perTaskRun;
  }
  if (draft.perDayUsdText.trim().length > 0 && perDay !== undefined) {
    budget.perDayUsd = perDay;
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
};

export const parseTags = (value: string): string[] => {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim().toLowerCase();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
};
