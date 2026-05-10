const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|secret|token)\s*[:=]\s*[^\s,]+/gi,
];

export const redactSecrets = (text: string, maxLen = 240): string => {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 3)}…`;
  return out;
};
