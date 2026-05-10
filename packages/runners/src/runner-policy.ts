import { resolve, sep, isAbsolute, normalize } from "node:path";

/**
 * Phase 3 runner policy. Pure logic — no FS access — used by
 * RunnerService and tested without spinning up real runners.
 *
 * Source: docs/architecture/security-and-approval-architecture.md
 *         (Path policy / Risk classification)
 */

export const isWithin = (parentDir: string, candidate: string): boolean => {
  if (!parentDir || !candidate) return false;
  const parent = normalize(resolve(parentDir));
  const child = normalize(resolve(candidate));
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
};

export const ensureAbsolute = (p: string): boolean => isAbsolute(p);

const DANGEROUS_TOKENS: readonly RegExp[] = [
  /(?:^|\s)rm(?:\s|$)/i,
  /\brm\s+-r/i,
  /\brm\s+-rf/i,
  /(?:^|\s)del(?:\s|$)/i,
  /\bRemove-Item\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bcurl\s+/i,
  /\bwget\s+/i,
  /\bsudo\b/i,
  /\bdoskey\b/i,
  /\bformat\s+[a-zA-Z]:/i,
];

export interface DangerousCheck {
  dangerous: boolean;
  reason?: string;
}

const TEST_TOKENS: readonly RegExp[] = [
  /\bnpm\s+(?:run\s+)?test\b/i,
  /\byarn\s+test\b/i,
  /\bpnpm\s+(?:run\s+)?test\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bmocha\b/i,
  /\bpytest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bdotnet\s+test\b/i,
];

/** Returns true when the shell command looks like a test invocation. */
export const isTestCommand = (cmd: string): boolean => {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  return TEST_TOKENS.some((re) => re.test(cmd));
};

export const classifyShellCommand = (cmd: string): DangerousCheck => {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    return { dangerous: true, reason: "empty command" };
  }
  for (const re of DANGEROUS_TOKENS) {
    if (re.test(cmd)) {
      return { dangerous: true, reason: `matches ${re.source}` };
    }
  }
  return { dangerous: false };
};

const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub PAT, generic 40+ char hex/base64 tokens
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\b[A-Za-z0-9_\-]{32,}\b(?=\s*$)/gm,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  /(api[_-]?key|secret|token|password)["'`\s:=]+([^"'`\s]+)/gi,
];

/**
 * Replace secret-looking tokens in stdout/stderr text before showing
 * in UI or storing in LearningTrace. Pure regex — does not catch all
 * secrets; intended as a tripwire, not a guarantee.
 */
export const maskSecrets = (text: string): string => {
  if (typeof text !== "string" || text.length === 0) return text;
  let masked = text;
  for (const re of SECRET_PATTERNS) {
    masked = masked.replace(re, "[REDACTED]");
  }
  return masked;
};
