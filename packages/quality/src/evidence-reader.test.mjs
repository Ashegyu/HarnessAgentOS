import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEvidence } from "./evidence-reader.ts";

// These fixtures explicitly model host ledger records. Labels are deliberately
// not parsed: build/test/smoke kinds are supplied by the execution fixture.
const collectRecorded = (steps, artifacts, kinds = ["test"]) => {
  const output = [...artifacts];
  const runs = steps.filter(step => step.kind === "shell" || step.kind === "test").map((step, index) => {
    let artifact = output.find(row => row.stepId === step.id && row.taskRunId === step.taskRunId && ["test_result", "log"].includes(row.kind));
    if (!artifact) {
      artifact = { id: `host-${step.id}`, taskRunId: step.taskRunId, stepId: step.id, kind: "log" };
      output.push(artifact);
    }
    return { id: `run-${step.id}`, sequence: index + 1, taskRunId: step.taskRunId, stepId: step.id,
      approvalId: "approved", workspaceKey: "workspace", checkerId: `checker-${step.id}`, kinds,
      status: ["succeeded", "failed"].includes(step.status) ? "completed" : "running", exitCode: step.status === "failed" ? 1 : 0,
      startFingerprint: "current", finishFingerprint: "current", startGeneration: 0, finishGeneration: 0,
      artifactId: artifact.id, startedAt: "now", finishedAt: "now" };
  });
  return collectEvidence(steps, output, runs, { workspaceKey: "workspace", fingerprint: "current", generation: 0, activeMutations: 0 });
};

test("a complete host snapshot with zero changes is not a change or a test ordering barrier", () => {
  const evidence = collectRecorded([
    { id: "check", taskRunId: "task", index: 0, kind: "test", status: "succeeded", title: "test" },
    { id: "plan", taskRunId: "task", index: 1, kind: "plan", status: "succeeded", title: "plan" },
  ], [{ id: "snapshot", taskRunId: "task", stepId: "plan", kind: "diff",
    uri: "harness:workspace-change/task/123", summary: "# Workspace change evidence\n\nTarget: C:\\repo\nChanged files: 0\nSnapshot file list truncated: no\n\n## Changed-file manifest\n\nNo file changes observed.\n\n## Text diffs\n" }]);
  assert.deepEqual(evidence.diffArtifactIds, []);
  assert.equal(evidence.testEvidence.length, 1);
});

test("unknown, truncated, and non-host zero-change claims remain conservative", () => {
  for (const artifact of [
    { uri: "artifact://model", summary: "Changed files: 0" },
    { uri: "harness:workspace-change/task/1", summary: "# Workspace change evidence\nChanged files: 0\nSnapshot file list truncated: yes" },
    { uri: "harness:workspace-change/task/1", summary: "Changed files: 0" },
  ]) assert.deepEqual(collectEvidence([], [{ id: "diff", kind: "diff", ...artifact }]).diffArtifactIds, ["diff"]);
});

const stepBase = {
  id: "stp_x",
  taskRunId: "tsk_x",
  index: 0,
  title: "",
  status: "succeeded",
};

test("model-written pass and exit markers are not execution evidence", () => {
  const artifacts = ["test_result", "log"].map((kind, index) => ({
    id: `fake-${index}`, stepId: "plan", taskRunId: "tsk_x", kind,
    title: "npm run build test smoke", summary: "all passed exit=0",
  }));
  const evidence = collectEvidence([{ ...stepBase, id: "plan", kind: "plan" }], artifacts);
  assert.deepEqual(evidence.testEvidence, []);
  assert.deepEqual(evidence.buildEvidence, []);
  assert.deepEqual(evidence.smokeEvidence, []);
});

test("pending and running checks are not failed or passing evidence", () => {
  for (const status of ["pending", "running", "skipped"]) {
    const evidence = collectEvidence([
      { ...stepBase, kind: "test", status },
      { ...stepBase, kind: "shell", title: "npm run build", status },
    ], []);
    assert.deepEqual(evidence.testEvidence, []);
    assert.deepEqual(evidence.buildEvidence, []);
  }
});

test("checks before the latest file change cannot validate the new change", () => {
  const evidence = collectEvidence([
    { ...stepBase, id: "test", kind: "test", index: 0 },
    { ...stepBase, id: "edit", kind: "edit", index: 1 },
  ], [{ id: "diff", kind: "diff", taskRunId: "tsk_x", stepId: "edit" }]);
  assert.deepEqual(evidence.testEvidence, []);
});

test("collectEvidence flags failed host test execution", () => {
  const evidence = collectRecorded([{ ...stepBase, taskRunId: "tsk_1", kind: "test", status: "failed" }], [
    {
      id: "art_1",
      stepId: stepBase.id,
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
  const evidence = collectRecorded([{ ...stepBase, taskRunId: "tsk_1", kind: "test" }], [
    {
      id: "art_2",
      stepId: stepBase.id,
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

test("collectEvidence reads recorded test execution status", () => {
  const evidence = collectRecorded(
    [
      { ...stepBase, kind: "test", title: "run unit tests", status: "failed" },
    ],
    [],
  );
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.testEvidence[0].passed, false);
});

test("collectEvidence accepts an explicitly recorded build kind", () => {
  const evidence = collectRecorded(
    [
      {
        ...stepBase,
        kind: "shell",
        title: "npm run build",
        status: "succeeded",
      },
    ],
    [], ["build"],
  );
  assert.equal(evidence.buildEvidence.length, 1);
  assert.equal(evidence.buildEvidence[0].passed, true);
});

test("collectEvidence links build logs to terminal runner status", () => {
  const evidence = collectRecorded([{ ...stepBase, taskRunId: "tsk_1", kind: "shell", title: "npm run build" }], [
    {
      id: "art_b1",
      stepId: stepBase.id,
      taskRunId: "tsk_1",
      kind: "log",
      title: "shell: npm run build",
      uri: "artifact://b/1",
      createdAt: "2024-01-01T00:00:00.000Z",
      summary: "exit=0, 1500ms",
    },
  ], ["build"]);
  assert.equal(evidence.buildEvidence.length, 1);
  assert.equal(evidence.buildEvidence[0].passed, true);
  assert.equal(evidence.buildEvidence[0].artifactId, "art_b1");
});

test("collectEvidence detects failed build log artifacts", () => {
  const evidence = collectRecorded([{ ...stepBase, taskRunId: "tsk_1", kind: "shell", title: "dotnet build", status: "failed" }], [
    {
      id: "art_b2",
      stepId: stepBase.id,
      taskRunId: "tsk_1",
      kind: "log",
      title: "shell: dotnet build",
      uri: "artifact://b/2",
      createdAt: "2024-01-01T00:00:00.000Z",
      summary: "exit=1, 1500ms",
    },
  ], ["build"]);
  assert.equal(evidence.buildEvidence.length, 1);
  assert.equal(evidence.buildEvidence[0].passed, false);
  assert.equal(evidence.buildEvidence[0].artifactId, "art_b2");
});

test("collectEvidence accepts a recorded shell test invocation", () => {
  const evidence = collectRecorded(
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

test("collectEvidence does not count unit tests as smoke evidence", () => {
  const evidence = collectRecorded(
    [
      {
        ...stepBase,
        kind: "test",
        title: "vitest",
        status: "succeeded",
      },
    ],
    [],
  );
  assert.equal(evidence.testEvidence.length, 1);
  assert.equal(evidence.smokeEvidence.length, 0);
});

test("collectEvidence accepts a recorded smoke invocation", () => {
  const evidence = collectRecorded(
    [
      {
        ...stepBase,
        kind: "shell",
        title: "npm run smoke",
        status: "succeeded",
      },
    ],
    [], ["smoke"],
  );
  assert.equal(evidence.smokeEvidence.length, 1);
  assert.equal(evidence.smokeEvidence[0].passed, true);
});

test("collectEvidence links smoke logs to terminal runner status", () => {
  const evidence = collectRecorded([{ ...stepBase, taskRunId: "tsk_1", kind: "shell", title: "npm run smoke" }], [
    {
      id: "art_s1",
      stepId: stepBase.id,
      taskRunId: "tsk_1",
      kind: "log",
      title: "shell: npm run smoke",
      uri: "artifact://s/1",
      createdAt: "2024-01-01T00:00:00.000Z",
      summary: "exit=0, 500ms",
    },
  ], ["smoke"]);
  assert.equal(evidence.smokeEvidence.length, 1);
  assert.equal(evidence.smokeEvidence[0].passed, true);
  assert.equal(evidence.smokeEvidence[0].artifactId, "art_s1");
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
