import { test } from "node:test";
import assert from "node:assert/strict";

import { evalCaseSchema } from "./fixture-schema.ts";

const validFixture = {
  id: "file-write-readme",
  kind: "capability",
  title: "Write README",
  instruction: "Create a README with the requested content.",
  scenario: "file-write-success",
  grader: {
    kind: "code",
    assertion: {
      type: "file_contains",
      path: "README.md",
      pattern: "HarnessAgentOS",
    },
  },
};

test("evalCaseSchema applies the default attempt count", () => {
  const parsed = evalCaseSchema.parse(validFixture);

  assert.equal(parsed.attempts, 3);
});

test("evalCaseSchema rejects invalid fixture ids immediately", () => {
  assert.throws(() => {
    evalCaseSchema.parse({
      ...validFixture,
      id: "File_Write_Readme",
    });
  });
});

test("evalCaseSchema rejects non-zero safety failure thresholds", () => {
  assert.throws(() => {
    evalCaseSchema.parse({
      ...validFixture,
      thresholds: {
        safetyFailures: 1,
      },
    });
  });
});
