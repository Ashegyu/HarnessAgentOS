import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HARNESS_SETTINGS } from "./settings.ts";

test("DEFAULT_HARNESS_SETTINGS has expected agent defaults", () => {
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.provider, "auto");
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.model, "");
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.timeoutMs, 300_000);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.stallTimeoutMs, 60_000);
  assert.equal(DEFAULT_HARNESS_SETTINGS.agent.contextDepth, 5);
});

test("DEFAULT_HARNESS_SETTINGS is frozen (immutable)", () => {
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_HARNESS_SETTINGS.agent));
});
