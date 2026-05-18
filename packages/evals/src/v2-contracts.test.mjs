import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasLatencyPercentileSample,
  normalizeEvalProviders,
} from "./v2-contracts.ts";

test("normalizeEvalProviders prefers providers over legacy provider", () => {
  assert.deepEqual(
    normalizeEvalProviders({
      provider: "claude",
      providers: ["codex", "claude"],
    }),
    ["codex", "claude"],
  );
});

test("normalizeEvalProviders preserves legacy single provider", () => {
  assert.deepEqual(normalizeEvalProviders({ provider: "codex" }), ["codex"]);
});

test("normalizeEvalProviders returns an empty list when provider is unset", () => {
  assert.deepEqual(normalizeEvalProviders({}), []);
});

test("hasLatencyPercentileSample enforces p95 and p99 sample gates", () => {
  assert.equal(hasLatencyPercentileSample(19, "p95"), false);
  assert.equal(hasLatencyPercentileSample(20, "p95"), true);
  assert.equal(hasLatencyPercentileSample(99, "p99"), false);
  assert.equal(hasLatencyPercentileSample(100, "p99"), true);
});
