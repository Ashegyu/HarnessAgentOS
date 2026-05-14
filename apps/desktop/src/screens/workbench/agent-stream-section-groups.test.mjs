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

test("groups adjacent powershell commands with the same cmdlet", () => {
  const grouped = groupConsecutiveToolSections([
    tool(
      "s1",
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'Get-Content -Raw -Path index.html'",
    ),
    tool(
      "s2",
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'Get-Content -Raw -Path app.js'",
    ),
    tool(
      "s3",
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'Get-Content -First 80 -Path style.css'",
    ),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "tool_group");
  assert.equal(grouped[0].tools.length, 3);
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
    tool("s1", "git status --short"),
    tool("s2", "git diff --name-only"),
  ]);

  assert.deepEqual(
    grouped.map((section) => section.kind),
    ["tool", "tool"],
  );
});

test("does not group adjacent powershell commands with different cmdlets", () => {
  const grouped = groupConsecutiveToolSections([
    tool(
      "s1",
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'Get-Content -Raw -Path index.html'",
    ),
    tool(
      "s2",
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command \"Select-String -Path index.html -Pattern '<title>'\"",
    ),
  ]);

  assert.deepEqual(
    grouped.map((section) => section.kind),
    ["tool", "tool"],
  );
});
