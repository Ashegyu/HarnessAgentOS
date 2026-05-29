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

const INSTRUCTION_LIKE_AFTER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:please\s+)?(?:add|append|insert|update|modify|change|replace|create|implement|write|generate)\b[\s\S]{0,220}\b(?:file|class|method|function|section|code|content|contract)\b/i,
  /\b(?:to|in|inside|for)\s+(?:this|the)\s+file\b[\s\S]{0,160}\b(?:add|append|insert|update|modify|change|replace|implement|write)\b/i,
  /\b(?:add|append|insert)\s+(?:the\s+)?(?:following|below)\s+(?:code|content|section)\b/i,
  /\b(?:file|class|method|function|contract)\s+(?:should|must|needs to)\b/i,
  /\bfile_write\b[\s\S]{0,80}\b(?:proposal|propose|suggest)\b/i,
  /(?:이\s*)?파일에[\s\S]{0,220}(?:추가|작성|수정|구현|반영|넣)(?:하|해|합니다|하세요|하라)?/u,
  /(?:다음|아래)[\s\S]{0,120}(?:내용|코드|섹션)[\s\S]{0,120}(?:추가|삽입|작성|반영)(?:하|해|합니다|하세요|하라)?/u,
  /(?:추가|작성|수정|구현|반영|명확히)(?:하|해|합니다|하세요|하라)/u,
  /\b(?:public\s+contract|contract)\b[\s\S]{0,120}(?:clarify|명확)/iu,
];

const looksLikeInstructionInsteadOfFileContent = (after: string): boolean => {
  const sample = after.trim().slice(0, 1_200);
  if (sample.length === 0) return false;
  return INSTRUCTION_LIKE_AFTER_PATTERNS.some((pattern) => pattern.test(sample));
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
    case "file_patch":
      return validateFilePatch(raw);
    case "file_write":
      return validateFileWrite(raw);
    case "shell":
      return validateShell(raw);
    case "capability_use":
      return validateCapabilityUse(raw);
    case "model_use":
      return validateModelUse(raw);
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

const validateRelativePath = (
  fieldName: string,
  path: unknown,
): { ok: true; path: string } | { ok: false; reason: string } => {
  if (typeof path !== "string" || path.trim().length === 0) {
    return { ok: false, reason: `${fieldName} must be a non-empty string` };
  }
  if (containsNul(path)) {
    return { ok: false, reason: `${fieldName} must not contain NUL bytes` };
  }
  if (isAbsolutePath(path)) {
    return {
      ok: false,
      reason: `${fieldName} must be relative to TaskRun.targetDir`,
    };
  }
  if (path.split(/[\\/]/).some((seg) => seg === "..")) {
    return {
      ok: false,
      reason: `${fieldName} must not traverse parent directories (..)`,
    };
  }
  return { ok: true, path };
};

const validateFileWrite = (raw: Record<string, unknown>): ProposedActionValidation => {
  const filePatch = raw.filePatch;
  const dbSnapshotExport = raw.dbSnapshotExport;
  if (filePatch !== undefined && dbSnapshotExport !== undefined) {
    return {
      ok: false,
      reason: "file_write requires exactly one of filePatch or dbSnapshotExport",
    };
  }
  if (dbSnapshotExport !== undefined) {
    if (!isPlainObject(dbSnapshotExport)) {
      return {
        ok: false,
        reason: "file_write dbSnapshotExport must be an object",
      };
    }
    const targetPath = dbSnapshotExport.targetPath;
    if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
      return {
        ok: false,
        reason: "dbSnapshotExport.targetPath must be a non-empty string",
      };
    }
    if (containsNul(targetPath)) {
      return {
        ok: false,
        reason: "dbSnapshotExport.targetPath must not contain NUL bytes",
      };
    }
    return {
      ok: true,
      details: {
        type: "file_write",
        dbSnapshotExport: { targetPath },
      },
    };
  }
  if (!isPlainObject(filePatch)) {
    return { ok: false, reason: "file_write requires filePatch object" };
  }
  const parsedPath = validateRelativePath("filePatch.path", filePatch.path);
  if (!parsedPath.ok) return parsedPath;
  const after = filePatch.after;
  if (typeof after !== "string") {
    return { ok: false, reason: "filePatch.after must be a string" };
  }
  if (looksLikeInstructionInsteadOfFileContent(after)) {
    return {
      ok: false,
      reason:
        "filePatch.after must be complete file content, not natural-language edit instructions",
    };
  }
  const before =
    filePatch.before === undefined ? undefined : String(filePatch.before);
  const normalized: ProposedActionDetails = {
    type: "file_write",
    filePatch: {
      path: parsedPath.path,
      after,
      ...(before !== undefined ? { before } : {}),
    },
  };
  return { ok: true, details: normalized };
};

const validateFilePatch = (raw: Record<string, unknown>): ProposedActionValidation => {
  const unifiedPatch = raw.unifiedPatch;
  if (!isPlainObject(unifiedPatch)) {
    return { ok: false, reason: "file_patch requires unifiedPatch object" };
  }
  const parsedPath = validateRelativePath("unifiedPatch.path", unifiedPatch.path);
  if (!parsedPath.ok) return parsedPath;
  const patch = unifiedPatch.patch;
  if (typeof patch !== "string" || patch.trim().length === 0) {
    return {
      ok: false,
      reason: "unifiedPatch.patch must be a non-empty string",
    };
  }
  if (containsNul(patch)) {
    return { ok: false, reason: "unifiedPatch.patch must not contain NUL bytes" };
  }
  const parsedPatch = normalizeSingleFileUnifiedDiff(patch);
  if (!parsedPatch.ok) {
    return {
      ok: false,
      reason: parsedPatch.reason,
    };
  }
  const normalized: ProposedActionDetails = {
    type: "file_patch",
    unifiedPatch: {
      path: parsedPath.path,
      patch: parsedPatch.patch,
    },
  };
  return { ok: true, details: normalized };
};

const normalizeSingleFileUnifiedDiff = (
  patch: string,
): { ok: true; patch: string } | { ok: false; reason: string } => {
  const normalized = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  const lines = normalized.split("\n");
  const diffHeaders = lines
    .map((line, index) => (line.startsWith("diff --git ") ? index : -1))
    .filter((index) => index >= 0);
  if (diffHeaders.length > 1) {
    return {
      ok: false,
      reason: "unifiedPatch.patch must contain exactly one file diff",
    };
  }
  const headerIndex =
    diffHeaders.length === 1
      ? lines.findIndex((line, index) => index > diffHeaders[0]! && line.startsWith("--- "))
      : 0;
  if (headerIndex < 0) {
    return {
      ok: false,
      reason:
        "unifiedPatch.patch must be a unified diff with ---/+++ headers and at least one hunk",
    };
  }
  const unifiedLines = lines.slice(headerIndex);
  if (
    unifiedLines[0]?.startsWith("--- ") !== true ||
    unifiedLines[1]?.startsWith("+++ ") !== true ||
    !unifiedLines.some(isHunkHeaderLike)
  ) {
    return {
      ok: false,
      reason:
        "unifiedPatch.patch must be a unified diff with ---/+++ headers and at least one hunk",
    };
  }
  if (unifiedLines.slice(2).some((line) => line.startsWith("diff --git "))) {
    return {
      ok: false,
      reason: "unifiedPatch.patch must contain exactly one file diff",
    };
  }
  return { ok: true, patch: unifiedLines.join("\n") };
};

const isHunkHeaderLike = (line: string): boolean =>
  line.startsWith("@@ ") || line.trim() === "@@";

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

const validateModelUse = (
  raw: Record<string, unknown>,
): ProposedActionValidation => {
  const modelUse = raw.modelUse;
  if (!isPlainObject(modelUse)) {
    return { ok: false, reason: "model_use requires modelUse object" };
  }
  const model = modelUse.model;
  const reason = modelUse.reason;
  const recommendationId = modelUse.recommendationId;
  const confidence = modelUse.confidence;
  const estimatedCostUsd = modelUse.estimatedCostUsd;
  if (typeof model !== "string" || model.trim().length === 0) {
    return { ok: false, reason: "modelUse.model must be a non-empty string" };
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, reason: "modelUse.reason must be a non-empty string" };
  }
  if (
    typeof recommendationId !== "string" ||
    recommendationId.trim().length === 0
  ) {
    return {
      ok: false,
      reason: "modelUse.recommendationId must be a non-empty string",
    };
  }
  if (typeof confidence !== "number") {
    return { ok: false, reason: "modelUse.confidence must be a number" };
  }
  if (
    estimatedCostUsd !== undefined &&
    (typeof estimatedCostUsd !== "number" ||
      !Number.isFinite(estimatedCostUsd) ||
      estimatedCostUsd < 0)
  ) {
    return {
      ok: false,
      reason: "modelUse.estimatedCostUsd must be a non-negative number",
    };
  }
  const normalized = {
    model: model.trim(),
    reason: reason.trim(),
    recommendationId: recommendationId.trim(),
    confidence,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
  return {
    ok: true,
    details: {
      type: "model_use",
      modelUse: normalized,
    },
  };
};
