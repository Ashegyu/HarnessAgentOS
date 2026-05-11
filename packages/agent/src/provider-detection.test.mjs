import { test } from "node:test";
import assert from "node:assert/strict";
import { providerForModel, defaultModelFor } from "./provider-detection.ts";

test("claude-* models route to the claude provider", () => {
  assert.equal(providerForModel("claude-sonnet-4-6"), "claude");
  assert.equal(providerForModel("claude-opus-4-7"), "claude");
});

test("gpt/codex/o-prefixed models route to the codex provider", () => {
  assert.equal(providerForModel("gpt-5"), "codex");
  assert.equal(providerForModel("codex-mini"), "codex");
  assert.equal(providerForModel("o4-mini"), "codex");
});

test("unknown models do not resolve to a provider", () => {
  assert.equal(providerForModel("llama-3"), null);
  assert.equal(providerForModel(""), null);
  assert.equal(providerForModel("   "), null);
});

test("defaultModelFor returns a sensible default per provider", () => {
  assert.match(defaultModelFor("claude"), /^claude/);
  assert.match(defaultModelFor("codex"), /^gpt|^codex|^o/);
});
