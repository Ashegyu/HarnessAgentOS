import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySingleFileUnifiedPatch,
  UnifiedPatchError,
} from "./unified-patch.ts";

test("applySingleFileUnifiedPatch rejects header target mismatch", () => {
  assert.throws(
    () =>
      applySingleFileUnifiedPatch({
        path: "src/foo.ts",
        currentContent: "old\n",
        patch: "--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-old\n+new\n",
      }),
    (e) => e instanceof UnifiedPatchError && e.code === "RUNNER_PATCH_INVALID",
  );
});

test("applySingleFileUnifiedPatch rejects multi-file diffs", () => {
  assert.throws(
    () =>
      applySingleFileUnifiedPatch({
        path: "src/foo.ts",
        currentContent: "old\n",
        patch: [
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "--- a/src/bar.ts",
          "+++ b/src/bar.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "",
        ].join("\n"),
      }),
    (e) => e instanceof UnifiedPatchError && e.code === "RUNNER_PATCH_INVALID",
  );
});

test("applySingleFileUnifiedPatch rejects stale context", () => {
  assert.throws(
    () =>
      applySingleFileUnifiedPatch({
        path: "src/foo.ts",
        currentContent: "new\n",
        patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
      }),
    (e) =>
      e instanceof UnifiedPatchError &&
      e.code === "RUNNER_PATCH_CONTEXT_MISMATCH",
  );
});

test("applySingleFileUnifiedPatch applies context-based bare hunk headers", () => {
  const result = applySingleFileUnifiedPatch({
    path: "src/foo.ts",
    currentContent: ["alpha", "one", "two", "three", "omega"].join("\n"),
    patch: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  });

  assert.equal(result.afterContent, ["alpha", "one", "TWO", "three", "omega"].join("\n"));
});

test("applySingleFileUnifiedPatch rejects ambiguous bare hunk context", () => {
  assert.throws(
    () =>
      applySingleFileUnifiedPatch({
        path: "src/foo.ts",
        currentContent: ["one", "two", "three", "one", "two", "three"].join("\n"),
        patch: [
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@",
          " one",
          "-two",
          "+TWO",
          " three",
          "",
        ].join("\n"),
      }),
    (e) =>
      e instanceof UnifiedPatchError &&
      e.code === "RUNNER_PATCH_CONTEXT_MISMATCH",
  );
});

test("applySingleFileUnifiedPatch tolerates stale hunk line counts when context matches", () => {
  const result = applySingleFileUnifiedPatch({
    path: "src/foo.ts",
    currentContent: ["alpha", "one", "two", "three", "omega"].join("\n"),
    patch: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -2,6 +2,7 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  });

  assert.equal(result.afterContent, ["alpha", "one", "TWO", "three", "omega"].join("\n"));
});

test("applySingleFileUnifiedPatch falls back to unique context when hunk line number is stale", () => {
  const result = applySingleFileUnifiedPatch({
    path: "src/foo.ts",
    currentContent: ["header", "alpha", "one", "two", "three", "omega"].join("\n"),
    patch: [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -99,3 +99,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  });

  assert.equal(
    result.afterContent,
    ["header", "alpha", "one", "TWO", "three", "omega"].join("\n"),
  );
});

test("applySingleFileUnifiedPatch rejects stale hunk line numbers with ambiguous context", () => {
  assert.throws(
    () =>
      applySingleFileUnifiedPatch({
        path: "src/foo.ts",
        currentContent: ["one", "two", "three", "one", "two", "three"].join("\n"),
        patch: [
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@ -99,3 +99,3 @@",
          " one",
          "-two",
          "+TWO",
          " three",
          "",
        ].join("\n"),
      }),
    (e) =>
      e instanceof UnifiedPatchError &&
      e.code === "RUNNER_PATCH_CONTEXT_MISMATCH",
  );
});
