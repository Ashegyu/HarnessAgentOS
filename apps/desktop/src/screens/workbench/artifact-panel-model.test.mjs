import { test } from "node:test";
import assert from "node:assert/strict";
import { filterArtifacts } from "./artifact-panel-model.ts";

const artifact = (overrides = {}) => ({
  id: "art_1",
  taskRunId: "tsk_1",
  kind: "log",
  title: "Build log",
  uri: "artifact://log/1",
  createdAt: "2026-05-18T00:00:00.000Z",
  ...overrides,
});

test("filterArtifacts returns all artifacts for an empty query", () => {
  const rows = [artifact(), artifact({ id: "art_2" })];
  assert.deepEqual(filterArtifacts(rows, "   ").map((row) => row.id), [
    "art_1",
    "art_2",
  ]);
});

test("filterArtifacts matches title, kind, summary, uri, and id", () => {
  const rows = [
    artifact({ id: "art_build", title: "Build log", summary: "npm run build" }),
    artifact({
      id: "art_diff",
      kind: "diff",
      title: "src/index.ts",
      uri: "artifact://diff/1",
    }),
  ];
  assert.deepEqual(filterArtifacts(rows, "build").map((row) => row.id), [
    "art_build",
  ]);
  assert.deepEqual(filterArtifacts(rows, "diff").map((row) => row.id), [
    "art_diff",
  ]);
  assert.deepEqual(filterArtifacts(rows, "artifact://log").map((row) => row.id), [
    "art_build",
  ]);
  assert.deepEqual(filterArtifacts(rows, "art_diff").map((row) => row.id), [
    "art_diff",
  ]);
});

test("filterArtifacts requires every query term to match", () => {
  const rows = [
    artifact({ id: "art_1", title: "Build log", summary: "npm run build" }),
    artifact({ id: "art_2", title: "Test log", summary: "npm test" }),
  ];
  assert.deepEqual(filterArtifacts(rows, "log build").map((row) => row.id), [
    "art_1",
  ]);
});
