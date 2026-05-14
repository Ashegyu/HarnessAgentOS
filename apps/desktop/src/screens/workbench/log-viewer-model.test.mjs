import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLogContent } from "./log-viewer-model.ts";

test("parseLogContent keeps shell stdout/stderr sections separate", () => {
  const parsed = parseLogContent([
    "exit=1",
    "",
    "## stdout",
    "",
    "hello",
    "",
    "## stderr",
    "",
    "boom",
  ].join("\n"));

  assert.equal(parsed.kind, "shell");
  assert.equal(parsed.exitCode, "1");
  assert.equal(parsed.stdout, "hello");
  assert.equal(parsed.stderr, "boom");
});

test("parseLogContent exposes plain diagnostic logs instead of empty stdout/stderr", () => {
  const content = [
    "# Diagnostic log",
    "",
    "- subsystem: orchestration",
    "- phase: orchestration.draftPlan",
    "",
    "PIPELINE_REFERENCED_PROFILE_MISSING",
  ].join("\n");
  const parsed = parseLogContent(content);

  assert.equal(parsed.kind, "plain");
  assert.equal(parsed.content, content);
});
