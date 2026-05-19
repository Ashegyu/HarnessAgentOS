import type {
  AgentPermissions,
  AgentProfile,
  AgentReasoningEffort,
  ApprovalActionType,
} from "@harness/core";
import {
  AGENT_REASONING_EFFORTS,
  APPROVAL_ACTION_TYPES,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_CODEX_MODEL,
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
  reasoningEffort: AgentReasoningEffort | "";
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
  mcpServerIdsText: string;
  skillSourceIdsText: string;
  allowedSkillIdsText: string;
  toolAllowlistText: string;
  toolDenylistText: string;
  cliPathOverride: string;
  isDefault: boolean;
}

export type PermissionMode = "default" | "auto" | "block";

export interface BindingPolicyHint {
  tone: "info" | "warning";
  message: string;
}

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "auto",
  "block",
];

const numToText = (n: number | undefined): string =>
  n === undefined ? "" : String(n);

const listToText = (values: readonly string[]): string => values.join("\n");

const isReasoningEffort = (value: unknown): value is AgentReasoningEffort =>
  typeof value === "string" &&
  (AGENT_REASONING_EFFORTS as readonly string[]).includes(value);

const parseList = (value: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[\r\n,]+/)) {
    const item = raw.trim();
    if (item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

export const buildBindingPolicyHints = (
  draft: ProfileDraft,
): BindingPolicyHint[] => {
  const mcpServerIds = parseList(draft.mcpServerIdsText);
  const skillSourceIds = parseList(draft.skillSourceIdsText);
  const allowedSkillIds = parseList(draft.allowedSkillIdsText);
  const toolAllowlist = parseList(draft.toolAllowlistText);
  const toolDenylist = parseList(draft.toolDenylistText);
  const hints: BindingPolicyHint[] = [];
  const hasMcpBindings = mcpServerIds.length > 0;
  const hasToolPolicy =
    toolAllowlist.length > 0 || toolDenylist.length > 0;

  if (draft.provider === "codex" && hasMcpBindings) {
    hints.push({
      tone: "info",
      message:
        "Codex MCP binding은 per-run mcp_servers override로 적용됩니다. 현재 검증된 범위는 stdio/no-secret 서버이며, secret refs 또는 remote transport는 CLI 실행 전에 차단됩니다.",
    });
  }

  if (draft.provider === "codex" && hasToolPolicy) {
    hints.push({
      tone: "warning",
      message:
        "Codex provider cannot enforce AgentProfile tool policy yet; Claude를 선택하거나 unsupported profile boundary를 제거해야 실행 전 fail-fast를 피할 수 있습니다.",
    });
  } else if (draft.provider === "auto" && hasToolPolicy) {
    hints.push({
      tone: "warning",
      message:
        "provider=auto는 Codex로 선택될 수 있어 tool policy 적용이 보장되지 않습니다. enforced profile boundary가 필요하면 Claude로 고정하세요.",
    });
  }

  if (draft.provider === "auto" && hasMcpBindings) {
    hints.push({
      tone: "info",
      message:
        "Codex MCP binding은 auto provider가 Codex로 선택될 때 stdio/no-secret 서버에 한해 per-run mcp_servers override로 적용됩니다.",
    });
  }

  if (skillSourceIds.length > 0 && allowedSkillIds.length === 0) {
    hints.push({
      tone: "info",
      message:
        "Skill source가 선택되어 있고 allowedSkillIds가 비어 있어 전체 enabled Skill 후보를 허용합니다.",
    });
  }

  if (toolDenylist.length > 0) {
    hints.push({
      tone: "info",
      message: "tool deny pattern이 allow pattern보다 우선 적용됩니다.",
    });
  }

  if (toolAllowlist.length > 0 || toolDenylist.length > 0) {
    hints.push({
      tone: "warning",
      message:
        "MCP tool pattern은 현재 Claude MCP config namespace 후보에 적용됩니다. 실제 직전 차단은 provider tool-call event 노출 확인 뒤에만 추가합니다.",
    });
  }

  return hints;
};

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
  provider: "codex",
  role: "coder",
  persona: "",
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: "xhigh",
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
  mcpServerIdsText: "",
  skillSourceIdsText: "",
  allowedSkillIdsText: "",
  toolAllowlistText: "",
  toolDenylistText: "",
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
  reasoningEffort: p.tuning.reasoningEffort ?? "",
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
  mcpServerIdsText: listToText(p.mcpServerIds),
  skillSourceIdsText: listToText(p.skillSourceIds),
  allowedSkillIdsText: listToText(p.permissions.allowedSkillIds),
  toolAllowlistText: listToText(p.permissions.toolAllowlist),
  toolDenylistText: listToText(p.permissions.toolDenylist),
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
  if (
    draft.reasoningEffort !== "" &&
    !isReasoningEffort(draft.reasoningEffort)
  ) {
    errors.push({
      field: "reasoningEffort",
      message: "Reasoning effort는 low/medium/high/xhigh/max 중 하나여야 합니다",
    });
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
  if (isReasoningEffort(draft.reasoningEffort)) {
    tuning.reasoningEffort = draft.reasoningEffort;
  }

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
    allowedSkillIds: parseList(draft.allowedSkillIdsText),
    toolAllowlist: parseList(draft.toolAllowlistText),
    toolDenylist: parseList(draft.toolDenylistText),
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
    mcpServerIds: parseList(draft.mcpServerIdsText),
    skillSourceIds: parseList(draft.skillSourceIdsText),
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
