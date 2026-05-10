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
  const tokens = tokenize(input.prompt);
  if (tokens.size === 0) return [];

  const out: CapabilitySuggestion[] = [];
  for (const cap of input.capabilities) {
    const matched: string[] = [];
    for (const term of cap.triggerTerms) {
      const norm = term.toLowerCase();
      if (norm.length === 0) continue;
      if (tokens.has(norm)) {
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

const tokenize = (prompt: string): Set<string> => {
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/u)
    .filter((t) => t.length > 0);
  return new Set(tokens);
};

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
