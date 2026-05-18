import type { EvalRunRecord } from "@harness/storage";
import { evalRunRecordToListItem } from "./viewer-read-model.ts";
import type { EvalCostTrendPoint, EvalRunMode } from "./types.ts";

export type EvalCostTrendWarningKind =
  | "tokens_increase"
  | "duration_increase"
  | "pass_rate_drop";

export interface EvalCostTrendWarning {
  readonly kind: EvalCostTrendWarningKind;
  readonly runId: string;
  readonly observed: number;
  readonly baseline: number;
  readonly threshold: number;
  readonly message: string;
}

export interface EvalCostTrendView {
  readonly points: ReadonlyArray<EvalCostTrendPoint>;
  readonly warnings: ReadonlyArray<EvalCostTrendWarning>;
  readonly baselineRunCount: number;
}

export interface EvalCostTrendOptions {
  readonly baselineWindow?: number;
  readonly tokenIncreaseRatio?: number;
  readonly durationIncreaseRatio?: number;
  readonly passRateDropDelta?: number;
}

const DEFAULT_BASELINE_WINDOW = 5;
const DEFAULT_TOKEN_INCREASE_RATIO = 1.2;
const DEFAULT_DURATION_INCREASE_RATIO = 1.3;
const DEFAULT_PASS_RATE_DROP_DELTA = 0.1;

const EVAL_RUN_MODES = new Set<EvalRunMode>([
  "fake",
  "real",
  "head_to_head",
  "judge",
  "production_latency",
]);

export const evalRunRecordToCostTrendPoint = (
  record: EvalRunRecord,
): EvalCostTrendPoint => {
  const item = evalRunRecordToListItem(record);
  const mode = typeof record.summary.mode === "string" &&
    EVAL_RUN_MODES.has(record.summary.mode as EvalRunMode)
    ? (record.summary.mode as EvalRunMode)
    : "unknown";
  const estimatedCostUsd = numberValue(
    (record.summary as { estimatedCostUsd?: unknown }).estimatedCostUsd,
  );

  return {
    runId: record.id,
    startedAt: record.startedAt,
    suite: item.suite,
    mode,
    totalTokens: item.totalTokens,
    totalDurationMs: item.totalDurationMs,
    passRate: item.passRate,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
};

export const computeEvalCostTrend = (
  records: ReadonlyArray<EvalRunRecord>,
  options: EvalCostTrendOptions = {},
): EvalCostTrendView => {
  const points = records
    .map(evalRunRecordToCostTrendPoint)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (points.length === 0) {
    return { points, warnings: [], baselineRunCount: 0 };
  }

  const latest = points[points.length - 1]!;
  const baselineWindow = clampPositiveInteger(
    options.baselineWindow,
    DEFAULT_BASELINE_WINDOW,
  );
  const baseline = points.slice(
    Math.max(0, points.length - 1 - baselineWindow),
    points.length - 1,
  );
  const warnings = buildWarnings(latest, baseline, options);

  return {
    points,
    warnings,
    baselineRunCount: baseline.length,
  };
};

const buildWarnings = (
  latest: EvalCostTrendPoint,
  baseline: ReadonlyArray<EvalCostTrendPoint>,
  options: EvalCostTrendOptions,
): EvalCostTrendWarning[] => {
  if (baseline.length === 0) return [];

  const warnings: EvalCostTrendWarning[] = [];
  const tokenBaseline = median(baseline.map((point) => point.totalTokens));
  const durationBaseline = median(
    baseline.map((point) => point.totalDurationMs),
  );
  const passRateBaseline = median(baseline.map((point) => point.passRate));
  const tokenRatio =
    positiveNumber(options.tokenIncreaseRatio) ??
    DEFAULT_TOKEN_INCREASE_RATIO;
  const durationRatio =
    positiveNumber(options.durationIncreaseRatio) ??
    DEFAULT_DURATION_INCREASE_RATIO;
  const passRateDropDelta =
    positiveNumber(options.passRateDropDelta) ?? DEFAULT_PASS_RATE_DROP_DELTA;

  if (tokenBaseline > 0 && latest.totalTokens > tokenBaseline * tokenRatio) {
    warnings.push({
      kind: "tokens_increase",
      runId: latest.runId,
      observed: latest.totalTokens,
      baseline: tokenBaseline,
      threshold: tokenBaseline * tokenRatio,
      message: "total tokens increased against recent baseline",
    });
  }

  if (
    durationBaseline > 0 &&
    latest.totalDurationMs > durationBaseline * durationRatio
  ) {
    warnings.push({
      kind: "duration_increase",
      runId: latest.runId,
      observed: latest.totalDurationMs,
      baseline: durationBaseline,
      threshold: durationBaseline * durationRatio,
      message: "total duration increased against recent baseline",
    });
  }

  if (
    passRateBaseline > 0 &&
    latest.passRate < passRateBaseline - passRateDropDelta
  ) {
    warnings.push({
      kind: "pass_rate_drop",
      runId: latest.runId,
      observed: latest.passRate,
      baseline: passRateBaseline,
      threshold: passRateBaseline - passRateDropDelta,
      message: "pass rate dropped against recent baseline",
    });
  }

  return warnings;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const positiveNumber = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

const clampPositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, 100);
};
