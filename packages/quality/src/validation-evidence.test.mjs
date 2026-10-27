import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEvidence } from "./evidence-reader.ts";

const current = { workspaceKey: "workspace", fingerprint: "revision-current", generation: 4, activeMutations: 0 };
const run = (id, sequence, patch = {}) => ({
  id, sequence, taskRunId: "task", stepId: `step-${id}`, approvalId: `approval-${id}`,
  workspaceKey: "workspace", checkerId: "node-tests", kinds: ["test"],
  startFingerprint: "revision-current", finishFingerprint: "revision-current",
  startGeneration: 4, finishGeneration: 4, status: "completed", exitCode: 0,
  artifactId: `artifact-${id}`, startedAt: "2026-10-27T00:00:00.000Z", finishedAt: "2026-10-27T00:00:00.000Z", ...patch,
});
const collect = (runs, snapshot = current, extraSteps = []) => {
  const steps = runs.map((row, index) => ({ id: row.stepId, taskRunId: row.taskRunId, index,
    kind: "test", title: "node --test", status: row.status === "running" ? "running" : row.exitCode === 0 ? "succeeded" : "failed" }));
  const artifacts = runs.filter(row => row.artifactId).map(row => ({ id: row.artifactId, taskRunId: row.taskRunId,
    stepId: row.stepId, kind: "test_result", uri: `artifact://${row.artifactId}`, createdAt: row.finishedAt, summary: "host process result" }));
  return collectEvidence([...steps, ...extraSteps], artifacts, runs, snapshot);
};

test("echo/title-only and free-standing result artifacts cannot establish actual validation", () => {
  const evidence = collectEvidence([{ id: "echo", taskRunId: "task", index: 0, kind: "shell", status: "succeeded",
    title: "echo test build smoke", inputSummary: "echo test build smoke" }], [
    { id: "fake", taskRunId: "task", stepId: "echo", kind: "test_result", summary: "passed exit=0" },
  ], [], current);
  assert.deepEqual(evidence.testEvidence, []);
  assert.deepEqual(evidence.buildEvidence, []);
  assert.deepEqual(evidence.smokeEvidence, []);
});

test("a same-checker rerun replaces its older failure at the same revision", () => {
  const evidence = collect([run("old-fail", 1, { exitCode: 1 }), run("new-pass", 2)]);
  assert.deepEqual(evidence.testEvidence, [{ passed: true, artifactId: "artifact-new-pass" }]);
});

test("a successful different checker does not hide another current failure", () => {
  const evidence = collect([run("fail", 1, { checkerId: "suite-A", exitCode: 1 }), run("pass", 2, { checkerId: "suite-B" })]);
  assert.equal(evidence.testEvidence.length, 2);
  assert.ok(evidence.testEvidence.some(row => row.passed === false));
});

test("latest-started execution supersedes an older late completion", () => {
  const evidence = collect([run("new-fail", 9, { exitCode: 1, finishedAt: "2026-10-27T00:00:01Z" }),
    run("old-pass", 8, { finishedAt: "2026-10-27T00:00:09Z" })]);
  assert.deepEqual(evidence.testEvidence, [{ passed: false, artifactId: "artifact-new-fail" }]);
});

test("a newer running execution prevents fallback to an older pass", () => {
  const evidence = collect([run("old", 1), run("pending", 2, { status: "running", exitCode: undefined, artifactId: undefined, finishedAt: undefined })]);
  assert.deepEqual(evidence.testEvidence, []);
});

for (const [name, patch] of [
  ["code changed after the run", { finishFingerprint: "older-revision", startFingerprint: "older-revision" }],
  ["code changed during the run", { startFingerprint: "older-revision" }],
  ["a host change was restored during the run", { startGeneration: 3 }],
  ["a newer host mutation followed the run", { startGeneration: 3, finishGeneration: 3 }],
  ["the input manifest could not be proven", { startFingerprint: null, finishFingerprint: null }],
]) {
  test(name + " cannot establish a passing check", () => {
    assert.deepEqual(collect([run("check", 1, patch)]).testEvidence, []);
  });
}

test("step display index does not replace actual code revision identity", () => {
  const evidence = collect([run("check", 1)], current, [{ id: "edit", taskRunId: "task", index: 99,
    kind: "edit", status: "succeeded", title: "edit before the check actually ran" }]);
  assert.deepEqual(evidence.testEvidence, [{ passed: true, artifactId: "artifact-check" }]);
});

test("an active workspace mutation or unreadable current manifest excludes success", () => {
  for (const patch of [{ activeMutations: 1 }, { fingerprint: null }]) {
    assert.deepEqual(collect([run("check", 1)], { ...current, ...patch }).testEvidence, []);
  }
});

test("a ledger result cannot borrow an artifact from another step", () => {
  const row = run("check", 1);
  const evidence = collectEvidence([{ id: row.stepId, taskRunId: "task", index: 0, kind: "test", title: "node --test", status: "succeeded" }],
    [{ id: row.artifactId, taskRunId: "task", stepId: "different-step", kind: "test_result" }], [row], current);
  assert.deepEqual(evidence.testEvidence, []);
});

test("a failed host attempt without an exit result is a failure, not a pass", () => {
  const evidence = collect([run("failed-spawn", 1, { status: "failed", exitCode: undefined, artifactId: undefined })]);
  assert.deepEqual(evidence.testEvidence, [{ passed: false }]);
});

test("a completed row without an exit code and a cancelled latest row cannot pass", () => {
  for (const patch of [{ exitCode: undefined }, { status: "cancelled", exitCode: undefined }]) {
    assert.deepEqual(collect([run("old", 1), run("new", 2, patch)]).testEvidence, []);
  }
});

test("ambiguous or invalid execution sequences cannot choose a convenient result", () => {
  for (const runs of [[run("a", 1), run("b", 1, { exitCode: 1 })], [run("invalid", 0)]]) {
    assert.deepEqual(collect(runs).testEvidence, []);
  }
});

test("foreign task records and a plan artifact cannot become check proof", () => {
  const row = run("check", 1);
  const step = { id: row.stepId, taskRunId: "task", index: 0, kind: "test", title: "node --test", status: "succeeded" };
  for (const [record, artifact] of [
    [{ ...row, taskRunId: "different-task" }, { id: row.artifactId, taskRunId: "task", stepId: row.stepId, kind: "test_result" }],
    [row, { id: row.artifactId, taskRunId: "task", stepId: row.stepId, kind: "plan" }],
  ]) assert.deepEqual(collectEvidence([step], [artifact], [record], current).testEvidence, []);
});
