import type { AgentProvider } from "@harness/core";
import { CodexExecStream } from "./codex-exec-stream.ts";
import type { ModelTokenUsage } from "./model-cli-types.ts";

export interface ModelPricing {
  inputUsdPerMillionTokens?: number;
  cachedInputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  /** Above this aggregate, per-request tier evidence is needed; never guess a multiplier. */
  maxStandardInputTokens?: number;
}

export type CostUnknownReason =
  | "billing_mode_unverified"
  | "pricing_unavailable"
  | "invalid_pricing"
  | "cached_pricing_unavailable"
  | "request_pricing_context_unavailable";

export interface ModelUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  approximate: boolean;
  source: "provider" | "heuristic";
  pricingModel?: string;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  costStatus: "estimated" | "unknown";
  costUnknownReason?: CostUnknownReason;
}

export interface EstimateModelUsageInput {
  provider: AgentProvider;
  model: string;
  systemPrompt?: string;
  prompt: string;
  output: string;
  rawOutput?: string;
  tokenUsage?: ModelTokenUsage | null;
  pricingCatalog?: Record<string, ModelPricing>;
  /** Host-verified billing mode, never inferred from a model name or token count. */
  billingMode?: "api" | "subscription" | "unknown";
}

export const estimateModelUsage = (
  input: EstimateModelUsageInput,
): ModelUsageEstimate => {
  const providerUsage = input.tokenUsage === undefined
    ? extractProviderUsage(input.rawOutput ?? "") : validTokenUsage(input.tokenUsage);
  const promptText = input.systemPrompt
    ? `${input.systemPrompt}\n${input.prompt}`
    : input.prompt;
  const inputTokens =
    providerUsage?.inputTokens ??
    estimateTokens(promptText);
  const outputTokens =
    providerUsage?.outputTokens ?? estimateTokens(input.output);
  const cost = estimateTokenCost(input, {
    inputTokens, outputTokens,
    cachedInputTokens: providerUsage?.cachedInputTokens ?? 0,
  });
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...cost,
    approximate: providerUsage === null,
    source: providerUsage === null ? "heuristic" : "provider",
    ...(cost.costStatus === "estimated" ? { pricingModel: input.model } : {}),
    ...(providerUsage ? {
      cachedInputTokens: providerUsage.cachedInputTokens,
      reasoningOutputTokens: providerUsage.reasoningOutputTokens,
    } : {}),
  };
};

export const usageEstimateToRecord = (
  estimate: ModelUsageEstimate,
): Record<string, unknown> => ({
  input_tokens: estimate.inputTokens,
  output_tokens: estimate.outputTokens,
  total_tokens: estimate.totalTokens,
  estimate_source: estimate.source,
  approximate: estimate.approximate,
  ...(estimate.cachedInputTokens !== undefined ? { cached_input_tokens: estimate.cachedInputTokens } : {}),
  ...(estimate.reasoningOutputTokens !== undefined ? { reasoning_output_tokens: estimate.reasoningOutputTokens } : {}),
  cost_status: estimate.costStatus,
  cost_source: estimate.costStatus === "estimated" ? "api_token_estimate" : "unavailable",
  ...(estimate.costUnknownReason ? { cost_unknown_reason: estimate.costUnknownReason } : {}),
});

const estimateTokens = (text: string): number => {
  const normalized = text.trim();
  if (normalized.length === 0) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
};

const extractProviderUsage = (
  rawOutput: string,
): ModelTokenUsage | null => {
  // Compatibility for stored/fake Codex invocations without captured usage.
  // Tool payloads and partially retained frames are not usage evidence.
  const stream = new CodexExecStream();
  stream.write(Buffer.from(rawOutput, "utf8"));
  stream.end();
  return stream.tokenUsage ?? null;
};

const validTokenUsage = (value: ModelTokenUsage | null): ModelTokenUsage | null => {
  if (!value || ![value.inputTokens, value.outputTokens, value.cachedInputTokens, value.reasoningOutputTokens]
    .every((count) => Number.isSafeInteger(count) && count >= 0) ||
    value.cachedInputTokens > value.inputTokens || value.reasoningOutputTokens > value.outputTokens ||
    !Number.isSafeInteger(value.inputTokens + value.outputTokens)) return null;
  return value;
};

const unknownCost = (costUnknownReason: CostUnknownReason) => ({
  costStatus: "unknown" as const, costUnknownReason,
});
const validRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const estimateTokenCost = (
  input: EstimateModelUsageInput,
  usage: Pick<ModelTokenUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">,
): Pick<ModelUsageEstimate, "costUsd" | "costStatus" | "costUnknownReason"> => {
  if (input.billingMode !== "api") return unknownCost("billing_mode_unverified");
  const catalog = input.pricingCatalog ?? {};
  if (!Object.hasOwn(catalog, input.model)) return unknownCost("pricing_unavailable");
  const pricing = catalog[input.model];
  if (
    !pricing ||
    !validRate(pricing.inputUsdPerMillionTokens) ||
    !validRate(pricing.outputUsdPerMillionTokens) ||
    (pricing.cachedInputUsdPerMillionTokens !== undefined &&
      !validRate(pricing.cachedInputUsdPerMillionTokens))
  ) {
    return unknownCost("invalid_pricing");
  }
  if (usage.cachedInputTokens > 0 && pricing.cachedInputUsdPerMillionTokens === undefined) {
    return unknownCost("cached_pricing_unavailable");
  }
  if (pricing.maxStandardInputTokens !== undefined) {
    if (
      !Number.isSafeInteger(pricing.maxStandardInputTokens) ||
      pricing.maxStandardInputTokens < 0
    ) return unknownCost("invalid_pricing");
    if (usage.inputTokens > pricing.maxStandardInputTokens) {
      return unknownCost("request_pricing_context_unavailable");
    }
  }
  // Token-only advisory estimate, not an invoice: tools/cache writes/tiers need
  // separate evidence. Reasoning is already included in provider outputTokens.
  const costUsd = (
    (usage.inputTokens - usage.cachedInputTokens) * pricing.inputUsdPerMillionTokens +
    usage.cachedInputTokens * (pricing.cachedInputUsdPerMillionTokens ?? 0) +
    usage.outputTokens * pricing.outputUsdPerMillionTokens
  ) / 1_000_000;
  return validRate(costUsd) ? { costStatus: "estimated", costUsd } : unknownCost("invalid_pricing");
};
