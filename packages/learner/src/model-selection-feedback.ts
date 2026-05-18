import type { LearningTrace } from "@harness/core";

/**
 * Phase 6 model selection helper. Picks the highest-reward model from
 * historical traces. Pure function with deterministic tie-breaking
 * (lexicographic). Returns undefined when no signal is available so the
 * advisor can fall back to a conservative default.
 */
export interface ModelStat {
  model: string;
  averageReward: number;
  sampleCount: number;
}

export interface ModelRecommendation {
  model?: string;
  rationale: string;
  confidence: number;
  estimatedCostUsd?: number;
}

export const summarizeModelPerformance = (
  traces: LearningTrace[],
): ModelStat[] => {
  const buckets = new Map<string, { total: number; count: number }>();
  for (const t of traces) {
    if (!t.selectedModel) continue;
    if (typeof t.reward !== "number") continue;
    const cur = buckets.get(t.selectedModel) ?? { total: 0, count: 0 };
    cur.total += t.reward;
    cur.count += 1;
    buckets.set(t.selectedModel, cur);
  }
  const out: ModelStat[] = [];
  for (const [model, { total, count }] of buckets) {
    out.push({ model, averageReward: total / count, sampleCount: count });
  }
  out.sort(
    (a, b) =>
      b.averageReward - a.averageReward || a.model.localeCompare(b.model),
  );
  return out;
};

export const recommendModel = (
  traces: LearningTrace[],
): ModelRecommendation => {
  const stats = summarizeModelPerformance(traces);
  if (stats.length === 0) {
    return {
      rationale: "No prior model selections recorded; falling back to default.",
      confidence: 0.1,
    };
  }
  const best = stats[0]!;
  const confidence = Math.min(1, 0.3 + best.sampleCount * 0.1);
  const estimatedCostUsd = estimateAverageCostUsd(traces, best.model);
  return {
    model: best.model,
    rationale: `Highest avg reward ${best.averageReward.toFixed(2)} over ${best.sampleCount} run(s).`,
    confidence,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
};

const estimateAverageCostUsd = (
  traces: LearningTrace[],
  model: string,
): number | undefined => {
  const costs = traces
    .filter((t) => t.selectedModel === model)
    .map((t) => t.costEstimate)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (costs.length === 0) return undefined;
  return costs.reduce((a, b) => a + b, 0) / costs.length;
};
