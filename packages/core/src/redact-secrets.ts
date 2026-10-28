// Shared pure audit policy; execution payloads remain unchanged.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(api[_-]?key|secret|token|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[:=]\s*[^\s,]+/gi,
];

const SENSITIVE_KEYS = new Set([
  "apikey", "secret", "token", "password", "passwd", "accesstoken", "refreshtoken",
  "clientsecret", "authorization", "credentials", "privatekey", "sessiontoken", "idtoken",
  "secretaccesskey", "awssecretaccesskey",
]);
const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEYS.has(key.replace(/[_\-\s]/g, "").toLowerCase());

// This fallback also handles JSON properties embedded in logs and Markdown.
// JSON.parse decodes escaped key names before the policy is applied.
const JSON_PROPERTY = /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*(?:"|\\?$)|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const CT_DEFAULT = /\b(?:(?:global::)?System\.Threading\.)?CancellationToken\s+[A-Za-z_]\w*\s*=\s*default(?:\s*\(\s*(?:(?:global::)?System\.Threading\.)?CancellationToken\s*\))?(?=\s*[,);])/g;
const CT_MARKERS = ["__HARNESS_CT_DEFAULT_0__","__HARNESS_CT_DEFAULT_1__","__HARNESS_CT_DEFAULT_2__","__HARNESS_CT_DEFAULT_3__"];

/** Create an audit copy without mutating structured tool/provider input. */
export const redactSecretValues = (value: unknown): unknown => {
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactSecrets(current, Number.MAX_SAFE_INTEGER);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return seen.get(current);
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(visit(item));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) {
      Object.defineProperty(result, key, { value: isSensitiveKey(key) ? "[REDACTED]" : visit(item),
        enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  return visit(value);
};

export const redactSecrets = (text: string, maxLen = 240): string => {
  let out = text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const redacted = JSON.stringify(redactSecretValues(parsed));
      // Preserve formatting and ordinary strings when the JSON had no secrets.
      if (redacted !== JSON.stringify(parsed)) out = redacted;
    } catch {
      // Partial JSON and surrounding prose still pass through the text masks.
    }
  }
  out = out.replace(JSON_PROPERTY, (match, key: string, separator: string, value: string) => {
    try {
      if (isSensitiveKey(JSON.parse(key) as string)) return `${key}${separator}"[REDACTED]"`;
      // Prose/fenced JSON is not parsed as a whole. Still inspect encoded JSON
      // inside ordinary fields such as a proposed file's `after` audit copy.
      if (value.startsWith('"')) {
        const decoded = JSON.parse(value) as string;
        const redacted = redactSecrets(decoded, Number.MAX_SAFE_INTEGER);
        if (redacted !== decoded) return `${key}${separator}${JSON.stringify(redacted)}`;
      }
      return match;
    } catch { return match; }
  });
  // A typed C# default value cannot contain credentials. Protect only this
  // complete declaration, so token-like parameter names do not consume code.
  // Other assignments, including adjacent real secrets, still pass all masks.
  const marker = CT_MARKERS.find(candidate => !out.includes(candidate));
  const declarations: string[] = [];
  if (marker) out = out.replace(CT_DEFAULT, declaration => `${marker}${declarations.push(declaration)-1}__`);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  if (marker && declarations.length) out = out.replace(new RegExp(`${marker}(\\d+)__`,"g"), (_match,index:string) => declarations[Number(index)]!);
  if (out.length > maxLen) out = `${out.slice(0, maxLen - 3)}…`;
  return out;
};
