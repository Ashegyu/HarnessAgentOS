import { isAbsolutePath } from "../path-policy.ts";
import type { ProposedActionDetails } from "../types/approval.ts";

export interface ProposedActionValidation {
  ok: boolean;
  reason?: string;
  /** Normalized payload with disallowed fields removed. */
  details?: ProposedActionDetails;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const containsNul = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
};

/**
 * Phase 3+ schema validation for the renderer-supplied
 * ProposedActionDetails. Runs at the IPC boundary so main never
 * trusts whatever the renderer sends.
 *
 * Container check: `cwd` is rejected outright (renderer cannot pick a
 * working directory; runner uses TaskRun.targetDir). Filesystem
 * containment of file_write paths is enforced separately by
 * runner-policy.isWithin at execution time.
 */
export const validateProposedActionDetails = (
  raw: unknown,
  expectedActionType: string,
): ProposedActionValidation => {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "details must be an object" };
  }
  const type = raw.type;
  if (typeof type !== "string" || type.trim().length === 0) {
    return { ok: false, reason: "details.type must be a non-empty string" };
  }
  if (type !== expectedActionType) {
    return {
      ok: false,
      reason: `details.type (${type}) must match approval.actionType (${expectedActionType})`,
    };
  }
  if (raw.cwd !== undefined) {
    return {
      ok: false,
      reason: "details.cwd is not allowed; runner uses TaskRun.targetDir",
    };
  }

  switch (type) {
    case "file_write":
      return validateFileWrite(raw);
    case "shell":
      return validateShell(raw);
    case "capability_use":
      return validateCapabilityUse(raw);
    case "dependency_install":
    case "git_commit":
    case "network":
    case "skill_script":
    case "orchestration_plan":
      // High-risk actions are rejected at the runner layer; the IPC
      // layer just normalizes the payload here so they do not silently
      // carry shell-style fields.
      return { ok: true, details: { type } };
    default:
      return { ok: false, reason: `Unsupported action type: ${type}` };
  }
};

const validateFileWrite = (raw: Record<string, unknown>): ProposedActionValidation => {
  const filePatch = raw.filePatch;
  if (!isPlainObject(filePatch)) {
    return { ok: false, reason: "file_write requires filePatch object" };
  }
  const path = filePatch.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return { ok: false, reason: "filePatch.path must be a non-empty string" };
  }
  if (containsNul(path)) {
    return { ok: false, reason: "filePatch.path must not contain NUL bytes" };
  }
  if (isAbsolutePath(path)) {
    return {
      ok: false,
      reason: "filePatch.path must be relative to TaskRun.targetDir",
    };
  }
  if (path.split(/[\\/]/).some((seg) => seg === "..")) {
    return {
      ok: false,
      reason: "filePatch.path must not traverse parent directories (..)",
    };
  }
  const after = filePatch.after;
  if (typeof after !== "string") {
    return { ok: false, reason: "filePatch.after must be a string" };
  }
  const before =
    filePatch.before === undefined ? undefined : String(filePatch.before);
  const normalized: ProposedActionDetails = {
    type: "file_write",
    filePatch: {
      path,
      after,
      ...(before !== undefined ? { before } : {}),
    },
  };
  return { ok: true, details: normalized };
};

const validateShell = (raw: Record<string, unknown>): ProposedActionValidation => {
  const command = raw.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, reason: "shell requires non-empty command string" };
  }
  if (containsNul(command)) {
    return { ok: false, reason: "shell command must not contain NUL bytes" };
  }
  if (command.length > 8192) {
    return { ok: false, reason: "shell command exceeds 8192 chars" };
  }
  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) {
      return { ok: false, reason: "shell args must be an array of strings" };
    }
    if (!raw.args.every((a) => typeof a === "string")) {
      return { ok: false, reason: "shell args must be strings" };
    }
    args = raw.args;
  }
  const normalized: ProposedActionDetails = {
    type: "shell",
    command,
    ...(args !== undefined ? { args } : {}),
  };
  return { ok: true, details: normalized };
};

const validateCapabilityUse = (
  raw: Record<string, unknown>,
): ProposedActionValidation => {
  const capabilityUse = raw.capabilityUse;
  if (!isPlainObject(capabilityUse)) {
    return { ok: false, reason: "capability_use requires capabilityUse object" };
  }
  const capabilityId = capabilityUse.capabilityId;
  const capabilityName = capabilityUse.capabilityName;
  const reason = capabilityUse.reason;
  const matchedTerms = capabilityUse.matchedTerms;
  if (typeof capabilityId !== "string" || capabilityId.trim().length === 0) {
    return {
      ok: false,
      reason: "capabilityUse.capabilityId must be a non-empty string",
    };
  }
  if (
    typeof capabilityName !== "string" ||
    capabilityName.trim().length === 0
  ) {
    return {
      ok: false,
      reason: "capabilityUse.capabilityName must be a non-empty string",
    };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return {
      ok: false,
      reason: "capabilityUse.reason must be a non-empty string",
    };
  }
  if (
    !Array.isArray(matchedTerms) ||
    !matchedTerms.every((term) => typeof term === "string")
  ) {
    return {
      ok: false,
      reason: "capabilityUse.matchedTerms must be an array of strings",
    };
  }
  return {
    ok: true,
    details: {
      type: "capability_use",
      capabilityUse: {
        capabilityId: capabilityId.trim(),
        capabilityName: capabilityName.trim(),
        reason: reason.trim(),
        matchedTerms,
      },
    },
  };
};
