import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEvidence } from "./evidence-reader.ts";

const stepBase = {
  id: "stp_x",
  taskRunId: "tsk_x",
  index: 0,
  title: "",
  status: "succeeded",
};

test("collectEvidence flags failed test_result artifact", () => {
  const evidence = collectEvidence([], [
    {
      id: "art_1",
      taskRunId: "tsk_1",
      kind: "test_result",
      title: "vitest",
      uri: "artifact://t/1",
      createdAt: "2024-01-01T00:00:00.000Z",
      summary: "vitest exit=1\nFailed 1 test",
    },
  ]);
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.testEvidence[0].passed, false);
  assert.equal(evidence.testEvidence[0].artifactId, "art_1");
});

test("collectEvidence marks passing test_result artifact", () => {
  const evidence = collectEvidence([], [
    {
      id: "art_2",
      taskRunId: "tsk_1",
      kind: "test_result",
      title: "jest",
      uri: "artifact://t/2",
      createdAt: "2024-01-01T00:00:00.000Z",
      summary: "all passed exit=0",
    },
  ]);
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.testEvidence[0].passed, true);
});

test("collectEvidence captures diff artifact ids", () => {
  const evidence = collectEvidence([], [
    {
      id: "art_d1",
      taskRunId: "tsk_1",
      kind: "diff",
      title: "diff",
      uri: "artifact://d/1",
      createdAt: "2024-01-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(evidence.diffArtifactIds, ["art_d1"]);
});

test("collectEvidence reads test step status as evidence", () => {
  const evidence = collectEvidence(
    [
      { ...stepBase, kind: "test", title: "run unit tests", status: "failed" },
    ],
    [],
  );
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.testEvidence[0].passed, false);
});

test("collectEvidence detects shell build steps via title hint", () => {
  const evidence = collectEvidence(
    [
      {
        ...stepBase,
        kind: "shell",
        title: "npm run build",
        status: "succeeded",
      },
    ],
    [],
  );
  assert.equal(evidence.buildEvidence.length, 1);
  assert.equal(evidence.buildEvidence[0].passed, true);
});

test("collectEvidence detects shell test invocations via output summary", () => {
  const evidence = collectEvidence(
    [
      {
        ...stepBase,
        kind: "shell",
        title: "run vitest suite",
        status: "succeeded",
        outputSummary: "vitest finished",
      },
    ],
    [],
  );
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.testEvidence[0].passed, true);
});

test("collectEvidence ignores pending shell steps", () => {
  const evidence = collectEvidence(
    [
      {
        ...stepBase,
        kind: "shell",
        title: "vitest",
        status: "pending",
      },
    ],
    [],
  );
  assert.equal(evidence.testEvidence.length, 0);
});
