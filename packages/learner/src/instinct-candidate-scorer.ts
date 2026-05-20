import type {
  CreateEvolutionCandidateInput,
  Observation,
} from "@harness/core";

export interface InstinctCandidateScorerInput {
  observations: Observation[];
  /** Minimum repeated signals required before a candidate is proposed. Default 3. */
  minSignals?: number;
}

export const scoreInstinctCandidates = (
  input: InstinctCandidateScorerInput,
): CreateEvolutionCandidateInput[] => {
  const minSignals = input.minSignals ?? 3;
  const groups = new Map<string, Observation[]>();

  for (const observation of input.observations) {
    if (!isCandidateSignal(observation)) continue;
    const key = [
      observation.projectKey ?? "",
      observation.source,
      observation.eventType,
      observation.signal,
      normalizeSummary(observation.summary),
    ].join("\u001f");
    const cur = groups.get(key) ?? [];
    cur.push(observation);
    groups.set(key, cur);
  }

  const candidates: CreateEvolutionCandidateInput[] = [];
  for (const group of groups.values()) {
    if (group.length < minSignals) continue;
    const first = group[0];
    if (!first) continue;
    const confidence = confidenceFor(group.length);
    const projectKey = commonProjectKey(group);
    const candidate: CreateEvolutionCandidateInput = {
      title: titleFor(first),
      proposedRule: ruleFor(first),
      rationale: rationaleFor(group),
      confidence,
      observationIds: group.map((o) => o.id),
    };
    if (projectKey) candidate.projectKey = projectKey;
    candidates.push(candidate);
  }

  return candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.title.localeCompare(b.title) ||
      a.proposedRule.localeCompare(b.proposedRule),
  );
};

const confidenceFor = (count: number): number =>
  Math.min(0.9, 0.3 + Math.max(0, count - 1) * 0.1);

const normalizeSummary = (summary: string): string =>
  summary.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

const isCandidateSignal = (observation: Observation): boolean => {
  if (observation.source === "approval") {
    return observation.eventType === "rejected";
  }
  if (observation.source === "quality") {
    return observation.eventType === "failed" || observation.signal === "failed";
  }
  return true;
};

const titleFor = (observation: Observation): string => {
  if (observation.source === "approval" && observation.eventType === "rejected") {
    return `Respect repeated ${observation.signal} rejections`;
  }
  if (observation.source === "quality" && observation.signal === "failed") {
    return "Prevent repeated quality gate failures";
  }
  return `Learn repeated ${observation.source}:${observation.signal}`;
};

const ruleFor = (observation: Observation): string => {
  if (observation.source === "approval" && observation.eventType === "rejected") {
    return `Do not automatically retry actions after the user rejects ${observation.signal}.`;
  }
  if (observation.source === "quality" && observation.signal === "failed") {
    return "Require stronger evidence before marking similar work ready for review.";
  }
  return `When ${observation.source}:${observation.eventType}:${observation.signal} repeats, surface the pattern as guidance before planning.`;
};

const rationaleFor = (group: Observation[]): string => {
  const first = group[0];
  const source = first ? `${first.source}:${first.eventType}:${first.signal}` : "unknown";
  return `${group.length} matching observations for ${source}.`;
};

const commonProjectKey = (group: Observation[]): string | undefined => {
  const first = group[0]?.projectKey;
  if (!first) return undefined;
  return group.every((o) => o.projectKey === first) ? first : undefined;
};
