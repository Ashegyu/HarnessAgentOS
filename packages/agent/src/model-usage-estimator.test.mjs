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
  assert.equal(estimate.outputTokens, 25);
  assert.equal(estimate.totalTokens, 125);
});

test("estimateModelUsage falls back to approximate character token counts", () => {
  const estimate = estimateModelUsage({
    provider: "claude",
    model: "unknown-model",
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
  });
});
