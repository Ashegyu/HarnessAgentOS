import type { AgentProvider } from "@harness/core";

export interface ModelPricing {
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

export interface ModelUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  approximate: boolean;
  source: "provider" | "heuristic";
  pricingModel?: string;
}

export interface EstimateModelUsageInput {
  provider: AgentProvider;
  model: string;
  systemPrompt?: string;
  prompt: string;
  output: string;
  rawOutput?: string;
  pricingCatalog?: Record<string, ModelPricing>;
}

export const estimateModelUsage = (
  input: EstimateModelUsageInput,
): ModelUsageEstimate => {
  const providerUsage = extractProviderUsage(input.rawOutput ?? "");
  const promptText = input.systemPrompt
    ? `${input.systemPrompt}\n${input.prompt}`
    : input.prompt;
  const inputTokens =
    providerUsage?.inputTokens ??
    estimateTokens(promptText);
  const outputTokens =
    providerUsage?.outputTokens ?? estimateTokens(input.output);
  const pricing = resolvePricing(input.model, input.pricingCatalog ?? {});
  const costUsd = pricing
    ? ((inputTokens * (pricing.inputUsdPerMillionTokens ?? 0)) +
        (outputTokens * (pricing.outputUsdPerMillionTokens ?? 0))) /
      1_000_000
    : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    approximate: providerUsage === null,
    source: providerUsage === null ? "heuristic" : "provider",
    ...(pricing ? { pricingModel: input.model } : {}),
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
});

const estimateTokens = (text: string): number => {
  const normalized = text.trim();
  if (normalized.length === 0) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
};

const extractProviderUsage = (
  rawOutput: string,
): { inputTokens: number; outputTokens: number } | null => {
  if (rawOutput.trim().length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      const usage = findUsageObject(obj);
      if (!usage) continue;
      const input =
        numberValue(usage["input_tokens"]) ??
        numberValue(usage["prompt_tokens"]) ??
        numberValue(usage["cache_creation_input_tokens"]) ??
        0;
      const output =
        numberValue(usage["output_tokens"]) ??
        numberValue(usage["completion_tokens"]) ??
        0;
      const cacheRead = numberValue(usage["cache_read_input_tokens"]) ?? 0;
      const reasoning = numberValue(usage["reasoning_output_tokens"]) ?? 0;
      inputTokens = Math.max(inputTokens, input + cacheRead);
      outputTokens = Math.max(outputTokens, output + reasoning);
      found = true;
    } catch {
      // Ignore non-JSON provider lines.
    }
  }
  return found ? { inputTokens, outputTokens } : null;
};

const findUsageObject = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (isRecord(value["usage"])) return value["usage"] as Record<string, unknown>;
  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      const usage = findUsageObject(child);
      if (usage) return usage;
    }
  }
  return null;
};

const resolvePricing = (
  model: string,
  catalog: Record<string, ModelPricing>,
): ModelPricing | null => {
  const direct = catalog[model];
  if (direct) return direct;
  const normalized = model.toLowerCase();
  const key = Object.keys(catalog).find((candidate) =>
    normalized.includes(candidate.toLowerCase()),
  );
  return key ? catalog[key] ?? null : null;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
