import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskContract } from "@harness/core";
import { defaultQualityRequirements } from "./quality-requirements.ts";

test("read-only requests do not default to build QA requirements", () => {
  for (const intent of ["answer", "review", "diagnose", "research"]) {
    assert.deepEqual(defaultQualityRequirements({ userRequest: "request", contract: buildTaskContract({ userRequest: "request", intent }) }), {
      requireBuild: false, requireTests: false, requireSmoke: false,
    });
  }
});

test("change requests retain the existing test requirement", () => {
  assert.equal(defaultQualityRequirements({ userRequest: "수정해줘" }).requireTests, true);
});
