import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestCapabilities } from "./capability-suggester.ts";

const cap = (overrides = {}) => ({
  id: overrides.id ?? "cap_1",
  source: overrides.source ?? "skillify:project",
  name: overrides.name ?? "Refactor",
  description: overrides.description ?? "Refactor helper",
  triggerTerms: overrides.triggerTerms ?? ["refactor", "rename"],
  riskLevel: overrides.riskLevel ?? "low",
  requiresApproval: overrides.requiresApproval ?? false,
});

test("suggest returns matched capabilities ranked by hit count", () => {
  const out = suggestCapabilities({
    prompt: "Please refactor and rename the helper",
    capabilities: [
      cap({ id: "cap_1", triggerTerms: ["refactor", "rename"] }),
      cap({ id: "cap_2", triggerTerms: ["build"] }),
      cap({ id: "cap_3", triggerTerms: ["refactor"] }),
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].capability.id, "cap_1");
  assert.equal(out[1].capability.id, "cap_3");
});

test("high-risk capabilities are penalized in ranking", () => {
  const out = suggestCapabilities({
    prompt: "refactor helper",
    capabilities: [
      cap({ id: "cap_high", riskLevel: "high", triggerTerms: ["refactor"] }),
      cap({ id: "cap_low", riskLevel: "low", triggerTerms: ["refactor"] }),
    ],
  });
  assert.equal(out[0].capability.id, "cap_low");
});

test("suggest returns empty when prompt has no overlap", () => {
  const out = suggestCapabilities({
    prompt: "weather forecast",
    capabilities: [cap({ triggerTerms: ["build"] })],
  });
  assert.deepEqual(out, []);
});

test("suggest reason includes matched terms", () => {
  const out = suggestCapabilities({
    prompt: "rename and extract helper",
    capabilities: [cap({ triggerTerms: ["rename", "extract"] })],
  });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /rename|extract/);
});

test("suggest matches multi-word trigger terms", () => {
  const out = suggestCapabilities({
    prompt: "Please run the tests before editing",
    capabilities: [cap({ triggerTerms: ["run the tests"] })],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].matchedTerms, ["run the tests"]);
});

test("suggest matches Korean trigger terms with polite suffixes", () => {
  const out = suggestCapabilities({
    prompt: "테스트 실행해줘",
    capabilities: [cap({ triggerTerms: ["테스트 실행"] })],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].matchedTerms, ["테스트 실행"]);
});

test("suggest keeps multi-word trigger terms ordered", () => {
  const out = suggestCapabilities({
    prompt: "The tests should run before editing",
    capabilities: [cap({ triggerTerms: ["run tests"] })],
  });
  assert.deepEqual(out, []);
});

test("suggest matches Korean single trigger terms inside a phrase", () => {
  const out = suggestCapabilities({
    prompt: "테스트실행해줘",
    capabilities: [cap({ triggerTerms: ["테스트"] })],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].matchedTerms, ["테스트"]);
});
