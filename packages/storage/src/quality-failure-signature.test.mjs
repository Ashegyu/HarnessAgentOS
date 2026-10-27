import { test } from "node:test";
import assert from "node:assert/strict";
import { qualityFailureSignature as signature } from "./quality-failure-signature.ts";

const gate = { status: "failed", testsPassed: false, knownRisks: ["tests failed"] };
const checker = { checkerId: "node-test", kinds: ["test", "smoke"], exitCode: 1 };

test("checker signatures canonicalize unordered sets without recording identities", () => {
  const other = { checkerId: "build", kinds: ["build"], exitCode: 2 };
  assert.match(signature(gate, [checker]), /^quality-v2:[a-f0-9]{64}$/);
  assert.equal(signature(gate, [checker, other]), signature(gate, [other, { ...checker, kinds: ["smoke", "test", "test"] }, checker]));
});

test("checker identity, classification and exit status distinguish observed failures", () => {
  for (const patch of [{ checkerId: "other" }, { kinds: ["test"] }, { exitCode: 2 }, { exitCode: null }]) {
    assert.notEqual(signature(gate, [checker]), signature(gate, [{ ...checker, ...patch }]));
  }
  assert.notEqual(signature(gate), signature(gate, [checker]));
});

test("gate flags and exact risk text retain distinctions without fuzzy normalization", () => {
  for (const patch of [{ status: "warning" }, { testsPassed: undefined }, { buildPassed: false },
    { smokePassed: false }, { knownRisks: ["Tests failed"] }, { knownRisks: ["tests failed "] },
    { knownRisks: ["failure 2 at /other/path"] }]) {
    assert.notEqual(signature(gate), signature({ ...gate, ...patch }));
  }
});
