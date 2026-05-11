import { validateTargetDir, type TargetDirValidation } from "../path-policy.ts";

/**
 * Extends path-policy with the Phase 2 contract: targetDir must be a
 * non-empty absolute path. POSIX absolute and Win32 drive paths are
 * both accepted; relative paths are rejected here per
 * phase-02 보안/승인 정책 ("targetDir는 절대경로로 normalize한다").
 */
export const validateAbsoluteTargetDir = (
  input: unknown,
): TargetDirValidation => {
  const base = validateTargetDir(input);
  if (!base.ok) return base;
  // Accept Windows drive, POSIX absolute, or UNC paths only.
  if (
    !/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(base.normalized) &&
    !base.normalized.startsWith("\\\\")
  ) {
    return { ok: false, reason: "targetDir must be an absolute path" };
  }
  return base;
};

/**
 * Async existence probe. Pure conversation-service can't touch fs;
 * the desktop main process injects this via ConversationService DI.
 */
export type PathExistsFn = (path: string) => Promise<boolean>;

export const noopPathExists: PathExistsFn = async () => true;
