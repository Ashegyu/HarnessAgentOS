import type { LearningTrace } from "@harness/core";

/**
 * Phase 6 trace summary helpers. Pure functions over LearningTrace rows.
 * Used by both the recorder (when persisting) and the advisor (when
 * shaping recommendations) to keep heuristics consistent.
 */

export const isSuccessful = (trace: LearningTrace): boolean | undefined => {
  if (trace.success === true) return true;
  if (trace.success === false) return false;
  // Fall back to reward-based inference when explicit success is missing.
  if (typeof trace.reward === "number") return trace.reward >= 0.5;
  return undefined;
};

export const traceSimilarity = (
  trace: LearningTrace,
  candidateCapabilityIds: ReadonlySet<string>,
): number => {
  if (candidateCapabilityIds.size === 0) return 0;
  const overlap = trace.selectedCapabilities.filter((id) =>
    candidateCapabilityIds.has(id),
  );
  return overlap.length / candidateCapabilityIds.size;
};

export const summarizeTrace = (trace: LearningTrace): string => {
  const parts: string[] = [];
  if (trace.selectedModel) parts.push(`model=${trace.selectedModel}`);
  if (typeof trace.reward === "number")
    parts.push(`reward=${trace.reward.toFixed(2)}`);
  if (typeof trace.latencyMs === "number")
    parts.push(`latency=${trace.latencyMs}ms`);
  if (typeof trace.costEstimate === "number")
    parts.push(`cost=${trace.costEstimate.toFixed(2)}`);
  if (trace.success === false && trace.failureReason)
    parts.push(`failed:${trace.failureReason.slice(0, 40)}`);
  return parts.join(" • ");
};
