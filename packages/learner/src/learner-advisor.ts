import {
  type CapabilitySuggestion,
  type EffortHint,
  type LearnerDecisionRecord,
  type LearnerRecommendation,
  type LearningTrace,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { suggestCapabilities } from "@harness/skillify-adapter";
import { recommendModel } from "./model-selection-feedback";
import { aggregateReward } from "./reward-evaluator";
import { traceSimilarity } from "./learning-trace";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/storage";
import { redactSecrets } from "./redact-secrets";

/**
 * Phase 6 advisor. Composes capability suggestions (Phase 5) with
 * historical LearningTrace stats to produce a single recommendation
 * per TaskRun. Never executes actions or modifies TaskRun state.
 *
 * Decision recording is append-only: a JSONL file under userData/learner-decisions.log
 * captures accept/reject, mirrored on disk so we can audit recommendations
 * even if the user clears the SQLite database.
 */

export interface LearnerAdvisorDeps {
  state: LocalStateService;
  /**
   * Directory on disk where decision audit lines are appended.
   * Caller must pass an absolute path; the file is created lazily.
   */
  decisionLogDir: string;
}

export class LearnerAdvisor {
  constructor(private readonly deps: LearnerAdvisorDeps) {}

  async recommend(input: {
    taskRunId: string;
  }): Promise<LearnerRecommendation> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new Error(`TaskRun ${input.taskRunId} not found`);
    }
    const [capabilities, traces] = await Promise.all([
      this.deps.state.listCapabilities(),
      this.deps.state.listLearningTraces(),
    ]);
    const baseSuggestions = suggestCapabilities({
      prompt: taskRun.userRequest,
      capabilities,
    });
    const reranked = rerankWithTraceHistory(baseSuggestions, traces);
    const modelChoice = recommendModel(traces);
    const aggregated = aggregateReward(traces);
    const costHint = inferCostHint(traces);
    const latencyHint = inferLatencyHint(traces);
    const rationale = buildRationale({
      reranked,
      modelChoice,
      aggregated,
      hasHistory: traces.length > 0,
    });
    const confidence = clamp(
      modelChoice.confidence * 0.5 +
        Math.min(1, traces.length * 0.05) * 0.3 +
        Math.min(1, reranked.length * 0.2) * 0.2,
      0,
      1,
    );

    const recommendation: LearnerRecommendation = {
      id: newId("learningTrace"),
      recommendedCapabilities: reranked,
      rationale,
      confidence,
    };
    if (modelChoice.model) recommendation.recommendedModel = modelChoice.model;
    if (costHint) recommendation.costHint = costHint;
    if (latencyHint) recommendation.latencyHint = latencyHint;
    return recommendation;
  }

  async getTrace(input: {
    taskRunId: string;
  }): Promise<LearningTrace | null> {
    return this.deps.state.getLearningTraceByTaskRun(input.taskRunId);
  }

  async recordDecision(record: LearnerDecisionRecord): Promise<void> {
    const line = JSON.stringify({
      ...record,
      reason: record.reason ? redactSecrets(record.reason, 240) : undefined,
      recordedAt: new Date().toISOString(),
    });
    await fs.mkdir(this.deps.decisionLogDir, { recursive: true });
    const file = join(this.deps.decisionLogDir, "decisions.jsonl");
    await fs.appendFile(file, `${line}\n`, "utf8");
  }
}

const rerankWithTraceHistory = (
  suggestions: CapabilitySuggestion[],
  traces: LearningTrace[],
): CapabilitySuggestion[] => {
  if (suggestions.length === 0) return suggestions;
  const candidateIds = new Set(suggestions.map((s) => s.capability.id));
  const traceBoost = new Map<string, number>();
  for (const t of traces) {
    if (typeof t.reward !== "number") continue;
    const sim = traceSimilarity(t, candidateIds);
    if (sim === 0) continue;
    for (const id of t.selectedCapabilities) {
      if (!candidateIds.has(id)) continue;
      const cur = traceBoost.get(id) ?? 0;
      traceBoost.set(id, cur + sim * t.reward);
    }
  }
  return [...suggestions]
    .map((s) => ({
      ...s,
      score: s.score + (traceBoost.get(s.capability.id) ?? 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.capability.name.localeCompare(b.capability.name),
    );
};

const inferCostHint = (traces: LearningTrace[]): EffortHint | undefined => {
  const costs = traces
    .map((t) => t.costEstimate)
    .filter((v): v is number => typeof v === "number");
  if (costs.length === 0) return undefined;
  const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
  if (avg < 0.05) return "low";
  if (avg < 0.5) return "medium";
  return "high";
};

const inferLatencyHint = (traces: LearningTrace[]): EffortHint | undefined => {
  const lats = traces
    .map((t) => t.latencyMs)
    .filter((v): v is number => typeof v === "number");
  if (lats.length === 0) return undefined;
  const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
  if (avg < 5_000) return "low";
  if (avg < 60_000) return "medium";
  return "high";
};

const buildRationale = (input: {
  reranked: CapabilitySuggestion[];
  modelChoice: { model?: string; rationale: string; confidence: number };
  aggregated: number;
  hasHistory: boolean;
}): string => {
  if (!input.hasHistory) {
    return "No prior trace history; recommending capability matches with conservative defaults.";
  }
  const top = input.reranked[0];
  const topPart = top
    ? `Top capability "${top.capability.name}" (score ${top.score.toFixed(2)}).`
    : "No capability matches found in history.";
  const modelPart = input.modelChoice.rationale;
  const aggPart = `Aggregate reward across ${
    input.aggregated >= 0 ? "positive" : "mixed"
  } past runs ≈ ${input.aggregated.toFixed(2)}.`;
  return [topPart, modelPart, aggPart].join(" ");
};

const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));
