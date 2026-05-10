import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRisks } from "./risk-policy.ts";

const empty = {
  steps: [],
  artifacts: [],
  testEvidence: [],
  buildEvidence: [],
  diffArtifactIds: [],
};

test("requireTests with no test evidence emits a missing-tests risk", () => {
  const risks = collectRisks(empty, { requireTests: true });
  assert.ok(risks.includes("required tests were not run"));
});

test("failed tests emit a 'tests failed' risk", () => {
  const risks = collectRisks(
    { ...empty, testEvidence: [{ passed: false }] },
    {},
  );
  assert.ok(risks.includes("tests failed in this run"));
});

test("requireBuild with no build evidence emits a missing-build risk", () => {
  const risks = collectRisks(empty, { requireBuild: true });
  assert.ok(risks.includes("required build evidence is missing"));
});

test("failed build emits a 'build failed' risk", () => {
  const risks = collectRisks(
    { ...empty, buildEvidence: [{ passed: false }] },
    {},
  );
  assert.ok(risks.includes("build failed in this run"));
});

test("requireSmoke with no test evidence emits a smoke missing risk", () => {
  const risks = collectRisks(empty, { requireSmoke: true });
  assert.ok(risks.includes("smoke evidence is missing"));
});

test("diff present without test evidence emits an untested-changes risk", () => {
  const risks = collectRisks(
    { ...empty, diffArtifactIds: ["art_d1"] },
    {},
  );
  assert.ok(
    risks.includes(
      "files were changed but no test evidence accompanies them",
    ),
  );
});

test("passing tests + no requirements emits no risks", () => {
  const risks = collectRisks(
    { ...empty, testEvidence: [{ passed: true }] },
    {},
  );
  assert.deepEqual(risks, []);
});
