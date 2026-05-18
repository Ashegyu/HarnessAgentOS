import type { EvalCase, EvalProvider } from "./types.ts";

export const EVAL_PROVIDER_VALUES = ["claude", "codex"] as const;

export type EvalLatencyPercentile = "p95" | "p99";

export const isEvalProvider = (value: string): value is EvalProvider =>
  (EVAL_PROVIDER_VALUES as ReadonlyArray<string>).includes(value);

export const normalizeEvalProviders = (
  value: Pick<EvalCase, "provider" | "providers">,
): ReadonlyArray<EvalProvider> => {
  if (value.providers && value.providers.length > 0) {
    return value.providers;
  }
  return value.provider ? [value.provider] : [];
};

export const hasLatencyPercentileSample = (
  count: number,
  percentile: EvalLatencyPercentile,
): boolean => {
  switch (percentile) {
    case "p95":
      return count >= 20;
    case "p99":
      return count >= 100;
  }
};
