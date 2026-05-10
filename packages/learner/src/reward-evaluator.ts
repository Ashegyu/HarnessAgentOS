import type { LearningTrace, QualityGateResult } from "@harness/core";

/**
 * Phase 6 reward computation. Combines QualityGateResult and runner
 * latency into a [-1, 1] scalar that biases future recommendations.
 * Pure function — no DB or FS access.
 *
 * Heuristic (per phase-06.md "복잡한 reinforcement learning은 하지 않는다"):
 *   - passed gate → +1
 *   - warning gate → +0.25
 *   - failed gate → -0.5
 *   - missing gate → 0 (neutral)
 *   - explicit failure (success=false) → floor at -0.5
 */
export interface RewardInput {
  qualityGate?: QualityGateResult | null;
  latencyMs?: number;
  success?: boolean;
}

export const computeReward = (input: RewardInput): number => {
  let score = 0;
  if (input.qualityGate) {
    switch (input.qualityGate.status) {
      case "passed":
        score = 1;
        break;
      case "warning":
        score = 0.25;
        break;
      case "failed":
        score = -0.5;
        break;
      case "not_run":
      default:
        score = 0;
    }
  }
  // Apply latency penalty for excessively slow runs (>2 minutes).
  if (typeof input.latencyMs === "number" && input.latencyMs > 120_000) {
    score -= 0.1;
  }
  if (input.success === false) {
    score = Math.min(score, -0.5);
  }
  if (score > 1) score = 1;
  if (score < -1) score = -1;
  return score;
};

export const aggregateReward = (traces: LearningTrace[]): number => {
  const scored = traces
    .map((t) => t.reward)
    .filter((r): r is number => typeof r === "number");
  if (scored.length === 0) return 0;
  let sum = 0;
  for (const s of scored) sum += s;
  return sum / scored.length;
};
