import { test } from "node:test";
import assert from "node:assert/strict";

import { DefaultModelCliAdapter, FakeModelCliAdapter } from "@harness/agent";

import { createEvalAdapterFactory } from "./adapter-factory.ts";

const testCase = {
  id: "file-write-readme",
  kind: "capability",
  title: "write readme",
  instruction: "write README",
  scenario: "ok-file-write-readme",
  attempts: 1,
  grader: {
    kind: "code",
    assertion: { type: "file_contains", path: "README.md", pattern: "Hello" },
  },
};

test("createEvalAdapterFactory returns FakeModelCliAdapter for deterministic eval", () => {
  const adapter = createEvalAdapterFactory({ realCli: false })({
    testCase,
    attemptIdx: 0,
  });

  assert.ok(adapter instanceof FakeModelCliAdapter);
});

test("createEvalAdapterFactory returns DefaultModelCliAdapter for real CLI smoke", () => {
  const adapter = createEvalAdapterFactory({ realCli: true })({
    testCase,
    attemptIdx: 0,
  });

  assert.ok(adapter instanceof DefaultModelCliAdapter);
});
