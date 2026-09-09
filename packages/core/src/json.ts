export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** Extract the first envelope without treating Markdown inside a JSON string as
 * its closing fence. This is only framing; callers still validate JSON/schema. */
export const extractAgentPlanEnvelope = (text: string): { json: string; start: number; end: number } | null => {
  const opening = /```harness_agent_plan(?=\s)\s*/.exec(text);
  if (!opening) return null;
  const contentStart = opening.index + opening[0].length;
  let inString = false;
  let escaped = false;
  for (let i = contentStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (text.startsWith("```", i)) {
      return { json: text.slice(contentStart, i).trim(), start: opening.index, end: i + 3 };
    }
  }
  return null;
};

export const parseJsonAllowingMultilineStrings = (
  rawJson: string,
): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(rawJson) };
  } catch (firstError) {
    const repaired = escapeControlCharsInsideJsonStrings(rawJson);
    if (repaired === rawJson) {
      return { ok: false, reason: jsonParseErrorMessage(firstError) };
    }
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch (secondError) {
      return { ok: false, reason: jsonParseErrorMessage(secondError) };
    }
  }
};

const escapeControlCharsInsideJsonStrings = (input: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (!inString) {
      out += ch;
      if (ch === "\"") inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\r") {
      changed = true;
      out += "\\n";
      if (input[i + 1] === "\n") i += 1;
      continue;
    }
    if (ch === "\n") {
      changed = true;
      out += "\\n";
      continue;
    }
    if (ch === "\t") {
      changed = true;
      out += "\\t";
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      changed = true;
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }

  return changed ? out : input;
};

const jsonParseErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
