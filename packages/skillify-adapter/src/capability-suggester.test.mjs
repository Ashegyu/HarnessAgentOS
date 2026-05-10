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
