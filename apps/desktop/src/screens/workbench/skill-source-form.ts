import type {
  ApprovalActionType,
  Capability,
  CapabilityRiskLevel,
  SkillAuthorDraft,
  SkillSource,
} from "@harness/core";

/**
 * Pure helpers for the SkillSourcesTab. The component handles state and
 * IPC; this module owns validation + display formatting so the React
 * code stays slim and the rules are testable without JSDOM.
 */

export interface AddSourceDraft {
  name: string;
  rootDir: string;
}

export interface SkillAuthorFormDraft {
  sourceId: string;
  slug: string;
  name: string;
  description: string;
  triggerTermsText: string;
  riskLevel: CapabilityRiskLevel;
  allowedActions: ApprovalActionType[];
  body: string;
}

export const emptyAddDraft = (): AddSourceDraft => ({
  name: "",
  rootDir: "",
});

export const emptySkillAuthorDraft = (
  sourceId = "",
): SkillAuthorFormDraft => ({
  sourceId,
  slug: "",
  name: "",
  description: "",
  triggerTermsText: "",
  riskLevel: "low",
  allowedActions: [],
  body: "",
});

export interface AddDraftError {
  field: keyof AddSourceDraft;
  message: string;
}

export interface SkillAuthorDraftError {
  field: keyof SkillAuthorFormDraft;
  message: string;
}

export const SKILL_AUTHOR_RISK_CHOICES: readonly CapabilityRiskLevel[] = [
  "low",
  "medium",
  "high",
];

export const SKILL_AUTHOR_ACTION_CHOICES: readonly ApprovalActionType[] = [
  "file_write",
  "shell",
  "network",
  "skill_script",
];

export const validateAddDraft = (
  draft: AddSourceDraft,
  existing: readonly SkillSource[],
): AddDraftError[] => {
  const errors: AddDraftError[] = [];
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  const root = draft.rootDir.trim();
  if (root.length === 0) {
    errors.push({ field: "rootDir", message: "디렉터리 경로는 필수입니다" });
  } else {
    // The IPC layer also enforces UNIQUE root_dir at the SQL level, but
    // catching it up-front means we surface a friendlier error before
    // the round-trip rather than a generic "constraint failed".
    if (existing.some((s) => normalizePath(s.rootDir) === normalizePath(root))) {
      errors.push({
        field: "rootDir",
        message: "이미 등록된 디렉터리입니다",
      });
    }
  }
  return errors;
};

/**
 * Tolerant comparison: Windows and POSIX paths might differ only in
 * casing or trailing separator. Avoid false-negative dup checks for
 * "C:\\Users\\me\\skills" vs "c:/users/me/skills/".
 */
export const normalizePath = (p: string): string =>
  p.trim().replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");

export const skillSlugFromName = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length > 0 ? slug : "new-skill";
};

export const skillAuthorDraftToInput = (
  draft: SkillAuthorFormDraft,
): SkillAuthorDraft => ({
  sourceId: draft.sourceId,
  slug: draft.slug.trim().toLowerCase(),
  name: draft.name.trim(),
  description: draft.description.trim(),
  triggerTerms: splitTerms(draft.triggerTermsText),
  riskLevel: draft.riskLevel,
  allowedActions: [...draft.allowedActions],
  body: draft.body,
});

export const skillAuthorInputToFormDraft = (
  draft: SkillAuthorDraft,
): SkillAuthorFormDraft => ({
  sourceId: draft.sourceId,
  slug: draft.slug,
  name: draft.name,
  description: draft.description,
  triggerTermsText: draft.triggerTerms.join(", "),
  riskLevel: draft.riskLevel,
  allowedActions: [...draft.allowedActions],
  body: draft.body,
});

export const validateSkillAuthorDraft = (
  draft: SkillAuthorFormDraft,
): SkillAuthorDraftError[] => {
  const errors: SkillAuthorDraftError[] = [];
  if (draft.sourceId.trim().length === 0) {
    errors.push({ field: "sourceId", message: "소스를 먼저 선택하세요" });
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(draft.slug.trim())) {
    errors.push({
      field: "slug",
      message: "skill id는 영문 소문자/숫자/-/_ 조합 2-63자여야 합니다",
    });
  }
  if (draft.name.trim().length === 0) {
    errors.push({ field: "name", message: "이름은 필수입니다" });
  }
  if (draft.description.trim().length === 0) {
    errors.push({ field: "description", message: "설명은 필수입니다" });
  }
  return errors;
};

const splitTerms = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

export const ORIGIN_LABELS: Record<SkillSource["origin"], string> = {
  project: "Project",
  user: "User",
  custom: "Custom",
};

/**
 * A multi-flag descriptor of where each source stands. Helps the UI
 * render the status pills consistently and is unit-testable without
 * touching React.
 */
export interface SourceStatus {
  /** True if the row is fully active for invocations. */
  ready: boolean;
  /** Human-readable reason when not ready. */
  reason?: string;
  /** Per-flag flags so the UI can highlight what's missing. */
  flags: {
    enabled: boolean;
    trusted: boolean;
    registered: boolean;
  };
}

export const describeStatus = (s: SkillSource): SourceStatus => {
  const flags = {
    enabled: s.enabled,
    trusted: s.trusted,
    registered: s.registeredInPathPolicy,
  };
  if (!s.enabled) return { ready: false, reason: "비활성", flags };
  if (!s.trusted) return { ready: false, reason: "trust 미승격", flags };
  if (!s.registeredInPathPolicy) {
    return { ready: false, reason: "path-policy 미등록", flags };
  }
  return { ready: true, flags };
};

export const skillSourceCapabilitySourceKey = (
  source: Pick<SkillSource, "id" | "origin">,
): string =>
  source.origin === "project"
    ? "skillify:project"
    : source.origin === "user"
      ? "skillify:user"
      : `skillify:${source.id}`;

export const capabilityCountForSource = (
  source: Pick<SkillSource, "id" | "origin">,
  capabilities: readonly Capability[],
): number => {
  const sourceKey = skillSourceCapabilitySourceKey(source);
  return capabilities.filter((capability) => capability.source === sourceKey)
    .length;
};
