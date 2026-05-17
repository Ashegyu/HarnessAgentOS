import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

test("file-write-readme fixture is valid EvalCase input", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.resolve(
    here,
    "../fixtures/capability/file-write-readme.eval.json",
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const parsed = evalCaseSchema.parse(fixture);

  assert.equal(parsed.id, "file-write-readme");
  assert.equal(parsed.attempts, 3);
});
