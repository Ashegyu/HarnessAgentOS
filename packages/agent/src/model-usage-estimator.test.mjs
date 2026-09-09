import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateModelUsage,
  usageEstimateToRecord,
} from "./model-usage-estimator.ts";

test("estimateModelUsage prefers provider usage metadata", () => {
  const estimate = estimateModelUsage({
    provider: "codex",
    model: "gpt-test",
    prompt: "hello",
    output: "world",
    rawOutput: JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    }),
  });
  assert.equal(estimate.source, "provider");
  assert.equal(estimate.approximate, false);
  assert.equal(estimate.inputTokens, 100);
  assert.equal(estimate.outputTokens, 20);
  assert.equal(estimate.totalTokens, 120);
});

test("estimateModelUsage prefers captured token usage over truncated or misleading logs", () => {
  const estimate = estimateModelUsage({ provider: "codex", model: "gpt-test", prompt: "hello", output: "world",
    tokenUsage: { inputTokens: 123, outputTokens: 45, cachedInputTokens: 23, reasoningOutputTokens: 5 },
    rawOutput: JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  assert.equal(estimate.inputTokens, 123);
  assert.equal(estimate.outputTokens, 45);
  assert.equal(estimate.approximate, false);
});

test("explicitly unavailable captured usage never promotes an earlier retained terminal to exact usage", () => {
  const estimate = estimateModelUsage({ provider: "codex", model: "gpt-test", prompt: "hello", output: "world",
    tokenUsage: null,
    rawOutput: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 999, output_tokens: 999 } }),
  });
  assert.equal(estimate.source, "heuristic");
  assert.equal(estimate.approximate, true);
  assert.notEqual(estimate.inputTokens, 999);
});

test("Codex usage ignores tool payloads and retains the latest cumulative total, not a sum", () => {
  const terminal = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
  const estimate = estimateModelUsage({ provider: "codex", model: "gpt-test", prompt: "hello", output: "world",
    rawOutput: [
      { type: "item.completed", item: { type: "mcp_tool_call", output: { usage: { input_tokens: 9999, output_tokens: 9999 } } } },
      terminal, terminal, { type: "turn.started" }, { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } },
    ].map(JSON.stringify).join("\n"),
  });
  assert.equal(estimate.inputTokens, 20);
  assert.equal(estimate.outputTokens, 10);
});

test("estimateModelUsage falls back to approximate character token counts", () => {
  const estimate = estimateModelUsage({
    provider: "codex",
    model: "gpt-5.6-luna",
    systemPrompt: "system".repeat(20),
    prompt: "prompt".repeat(20),
    output: "answer".repeat(20),
  });
  assert.equal(estimate.source, "heuristic");
  assert.equal(estimate.approximate, true);
  assert.ok(estimate.inputTokens > 0);
  assert.ok(estimate.outputTokens > 0);
  assert.equal(estimate.costUsd, undefined);
});

test("estimateModelUsage computes advisory cost only from supplied local catalog", () => {
  const estimate = estimateModelUsage({
    provider: "codex",
    model: "gpt-test",
    prompt: "a".repeat(400),
    output: "b".repeat(200),
    billingMode: "api",
    pricingCatalog: {
      "gpt-test": {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 2,
      },
    },
  });
  assert.equal(estimate.approximate, true);
  assert.equal(estimate.costUsd, 0.0002);
  assert.deepEqual(usageEstimateToRecord(estimate), {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    estimate_source: "heuristic",
    approximate: true,
    cost_status: "estimated",
    cost_source: "api_token_estimate",
  });
});

const usageInput = (overrides = {}) => ({
  provider: "codex", model: "gpt-test", prompt: "hello", output: "answer", billingMode: "api",
  tokenUsage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10 },
  pricingCatalog: { "gpt-test": { inputUsdPerMillionTokens: 10, cachedInputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 50 } },
  ...overrides,
});

test("cached input is discounted and reasoning is not billed twice", () => {
  const result = estimateModelUsage(usageInput());
  assert.equal(result.costUsd, 0.00164);
  assert.equal(result.costStatus, "estimated");
  assert.equal(result.cachedInputTokens, 40);
  assert.equal(result.reasoningOutputTokens, 10);
});

for (const billingMode of [undefined, "unknown", "subscription"]) {
  test(`API prices do not turn ${billingMode} billing into a USD charge`, () => {
    const result = estimateModelUsage(usageInput({ billingMode }));
    assert.equal(result.costUsd, undefined);
    assert.equal(result.costStatus, "unknown");
    assert.equal(result.costUnknownReason, "billing_mode_unverified");
  });
}

for (const pricing of [{}, { inputUsdPerMillionTokens: 10 },
  { inputUsdPerMillionTokens: -1, outputUsdPerMillionTokens: 1 },
  { inputUsdPerMillionTokens: NaN, outputUsdPerMillionTokens: 1 },
  { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: Infinity },
  { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, cachedInputUsdPerMillionTokens: -1 },
]) {
  test(`incomplete or invalid pricing is unknown: ${JSON.stringify(pricing)}`, () => {
    const result = estimateModelUsage(usageInput({ pricingCatalog: { "gpt-test": pricing } }));
    assert.equal(result.costUsd, undefined);
    assert.equal(result.costStatus, "unknown");
  });
}

test("exact model identity prevents substring and inherited catalog pricing", () => {
  for (const [model, pricingCatalog] of [
    ["gpt-test-pro", usageInput().pricingCatalog],
    ["GPT-TEST", usageInput().pricingCatalog],
    ["gpt-test", Object.create(usageInput().pricingCatalog)],
  ]) assert.equal(estimateModelUsage(usageInput({ model, pricingCatalog })).costUsd, undefined);
});

test("missing cached rate cannot silently charge cached tokens at the normal input rate", () => {
  const result = estimateModelUsage(usageInput({ pricingCatalog: { "gpt-test": { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50 } } }));
  assert.equal(result.costUsd, undefined);
  assert.equal(result.costUnknownReason, "cached_pricing_unavailable");
});

test("aggregate tokens crossing a context tier require request-level evidence", () => {
  const result = estimateModelUsage(usageInput({ pricingCatalog: { "gpt-test": { ...usageInput().pricingCatalog["gpt-test"], maxStandardInputTokens: 99 } } }));
  assert.equal(result.costUsd, undefined);
  assert.equal(result.costUnknownReason, "request_pricing_context_unavailable");
});

test("explicit zero rates are distinct from absent rates", () => {
  const result = estimateModelUsage(usageInput({ pricingCatalog: { "gpt-test": { inputUsdPerMillionTokens: 0, cachedInputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 } } }));
  assert.equal(result.costUsd, 0);
  assert.equal(result.costStatus, "estimated");
});

test("overflow cannot become a stored infinite cost", () => {
  const result = estimateModelUsage(usageInput({ pricingCatalog: { "gpt-test": { inputUsdPerMillionTokens: Number.MAX_VALUE, outputUsdPerMillionTokens: Number.MAX_VALUE, cachedInputUsdPerMillionTokens: Number.MAX_VALUE } } }));
  assert.equal(result.costUsd, undefined);
  assert.equal(result.costStatus, "unknown");
});
