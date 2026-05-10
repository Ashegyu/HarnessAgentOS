import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSimpleDiff, buildArtifactUri, EXT_BY_KIND } from "./index.ts";

test("formatSimpleDiff for new file emits + lines only", () => {
  const out = formatSimpleDiff({ path: "foo.ts", after: "line1\nline2" });
  assert.match(out, /\+\+\+ foo\.ts/);
  assert.match(out, /\+line1/);
  assert.match(out, /\+line2/);
  assert.doesNotMatch(out, /-line/);
});

test("formatSimpleDiff with before emits - and + sections", () => {
  const out = formatSimpleDiff({
    path: "foo.ts",
    before: "old",
    after: "new",
  });
  assert.match(out, /-old/);
  assert.match(out, /\+new/);
});

test("buildArtifactUri uses artifact:// scheme", () => {
  const uri = buildArtifactUri("tsk_1", "art_2");
  assert.equal(uri, "artifact://tsk_1/art_2");
});

test("EXT_BY_KIND covers all artifact kinds", () => {
  for (const kind of [
    "plan",
    "diff",
    "log",
    "test_result",
    "quality_report",
    "orchestration_plan",
    "file",
    "snapshot",
  ]) {
    assert.ok(EXT_BY_KIND[kind], `missing ext for ${kind}`);
  }
});
