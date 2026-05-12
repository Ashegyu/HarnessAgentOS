import type { SkillSource } from "@harness/core";

/**
 * Pure helpers for the SkillSourcesTab. The component handles state and
 * IPC; this module owns validation + display formatting so the React
 * code stays slim and the rules are testable without JSDOM.
 */

export interface AddSourceDraft {
  name: string;
  rootDir: string;
}

export const emptyAddDraft = (): AddSourceDraft => ({
  name: "",
  rootDir: "",
});

export interface AddDraftError {
  field: keyof AddSourceDraft;
  message: string;
}

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
