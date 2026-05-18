import type {
  RuntimeLatencyKind,
  RuntimeLatencySummary,
} from "./types.ts";
import { hasLatencyPercentileSample } from "./v2-contracts.ts";

export interface RuntimeLatencySample {
  readonly kind: RuntimeLatencyKind;
  readonly durationMs: number;
  readonly success?: boolean;
}

const RUNTIME_LATENCY_KIND_ORDER: readonly RuntimeLatencyKind[] = [
  "task_run_to_ready",
  "approval_to_runner_finished",
  "agent_invocation_to_first_token",
  "agent_invocation_to_final_result",
  "quality_evaluation_to_gate",
];

export const computeRuntimeLatencySummaries = (
  samples: ReadonlyArray<RuntimeLatencySample>,
): RuntimeLatencySummary[] => {
  const grouped = new Map<RuntimeLatencyKind, number[]>();
  for (const sample of samples) {
    if (!isValidDuration(sample.durationMs)) continue;
    const durations = grouped.get(sample.kind) ?? [];
    durations.push(sample.durationMs);
    grouped.set(sample.kind, durations);
  }

  return RUNTIME_LATENCY_KIND_ORDER.flatMap((kind) => {
    const durations = grouped.get(kind);
    return durations ? [summarizeKind(kind, durations)] : [];
  });
};

const summarizeKind = (
  kind: RuntimeLatencyKind,
  durations: ReadonlyArray<number>,
): RuntimeLatencySummary => {
  const sorted = durations.slice().sort((a, b) => a - b);
  const count = sorted.length;
  return {
    kind,
    count,
    p50Ms: median(sorted),
    p95Ms: hasLatencyPercentileSample(count, "p95")
      ? nearestRank(sorted, 0.95)
      : null,
    p99Ms: hasLatencyPercentileSample(count, "p99")
      ? nearestRank(sorted, 0.99)
      : null,
    maxMs: sorted[count - 1] ?? 0,
  };
};

const median = (sorted: ReadonlyArray<number>): number => {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const nearestRank = (
  sorted: ReadonlyArray<number>,
  percentile: number,
): number => {
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1),
  );
  return sorted[index]!;
};

const isValidDuration = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;
