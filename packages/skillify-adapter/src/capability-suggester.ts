import type { Capability, CapabilitySuggestion } from "@harness/core";

export interface SuggestInput {
  prompt: string;
  capabilities: Capability[];
  /** Optional cap on number of suggestions returned. Default 5. */
  limit?: number;
}

/**
 * Phase 5 capability suggester. Pure deterministic ranking based on
 * trigger-term overlap with the user prompt. Never changes TaskRun
 * state and never executes anything — just returns ranked candidates.
 */
export const suggestCapabilities = (
  input: SuggestInput,
): CapabilitySuggestion[] => {
  const limit = input.limit ?? 5;
  const promptTokens = tokenizeParts(input.prompt);
  if (promptTokens.length === 0) return [];

  const out: CapabilitySuggestion[] = [];
  for (const cap of input.capabilities) {
    const matched: string[] = [];
    for (const term of cap.triggerTerms) {
      const termTokens = tokenizeParts(term);
      if (termTokens.length === 0) continue;
      if (matchesTerm(promptTokens, termTokens)) {
        matched.push(term);
      }
    }
    if (matched.length === 0) continue;
    const score = scoreCapability(matched.length, cap);
    const reason = formatReason(matched, cap);
    out.push({ capability: cap, score, reason, matchedTerms: matched });
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.capability.name.localeCompare(b.capability.name),
  );
  return out.slice(0, limit);
};

const tokenizeParts = (input: string): string[] =>
  input
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/u)
    .filter((t) => t.length > 0);

const matchesTerm = (promptTokens: string[], termTokens: string[]): boolean => {
  if (termTokens.length > promptTokens.length) return false;

  for (let i = 0; i <= promptTokens.length - termTokens.length; i += 1) {
    const matches = termTokens.every((termToken, offset) => {
      const promptToken = promptTokens[i + offset];
      return promptToken !== undefined && tokenMatches(promptToken, termToken);
    });
    if (matches) return true;
  }
  return false;
};

const tokenMatches = (promptToken: string, termToken: string): boolean => {
  if (promptToken === termToken) return true;
  if (containsKorean(termToken) && promptToken.includes(termToken)) return true;
  return false;
};

const containsKorean = (value: string): boolean => /[가-힣]/u.test(value);

const scoreCapability = (matchCount: number, cap: Capability): number => {
  const base = matchCount;
  const riskPenalty =
    cap.riskLevel === "high" ? 0.5 : cap.riskLevel === "medium" ? 0.25 : 0;
  return base - riskPenalty;
};

const formatReason = (matched: string[], cap: Capability): string => {
  const matchList = matched.slice(0, 3).join(", ");
  const more = matched.length > 3 ? ` (+${matched.length - 3})` : "";
  return `Matched trigger terms: ${matchList}${more} — ${cap.riskLevel} risk`;
};
