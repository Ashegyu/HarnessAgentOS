import { test } from "node:test";
import assert from "node:assert/strict";
import { groupConsecutiveToolSections } from "./agent-stream-section-groups.ts";

const tool = (id, command, patch = {}) => ({
  id,
  kind: "tool",
  name: "command_execution",
  input: { command, ...patch },
});

test("groups adjacent tool sections with the same command", () => {
  const grouped = groupConsecutiveToolSections([
    tool("s1", "rg --files", { status: "in_progress" }),
    tool("s2", "rg --files", { status: "completed", exitCode: 0 }),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "tool_group");
  assert.equal(grouped[0].tools.length, 2);
  assert.deepEqual(
    grouped[0].tools.map((section) => section.id),
    ["s1", "s2"],
  );
  assert.deepEqual(grouped[0].input, {
    command: "rg --files",
    status: "completed",
    exitCode: 0,
  });
});

test("does not group the same command when another section is between them", () => {
  const grouped = groupConsecutiveToolSections([
    tool("s1", "rg --files"),
    { id: "s2", kind: "response", phase: "live", text: "확인 중" },
    tool("s3", "rg --files"),
  ]);

  assert.deepEqual(
    grouped.map((section) => section.kind),
    ["tool", "response", "tool"],
  );
});

test("does not group adjacent tools with different commands", () => {
  const grouped = groupConsecutiveToolSections([
    tool("s1", "rg --files"),
    tool("s2", "npm run check"),
  ]);

  assert.deepEqual(
    grouped.map((section) => section.kind),
    ["tool", "tool"],
  );
});
