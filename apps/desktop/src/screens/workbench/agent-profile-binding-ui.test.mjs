import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("AgentProfilesTab owns profile MCP and Skill binding pickers", () => {
  const source = readSource("AgentProfilesTab.tsx");

  assert.match(source, /window\.harness\.mcp\.list\(\)/);
  assert.match(source, /window\.harness\.skillSource\.list\(\)/);
  assert.match(source, /window\.harness\.capability\.list\(\)/);
  assert.match(source, /MCP servers/);
  assert.match(source, /Skill sources/);
  assert.match(source, /Allowed skill ids/);
  assert.match(source, /agent-profile-binding-list/);
});

test("MCP and Skill tabs no longer apply AgentProfile bindings directly", () => {
  for (const file of ["McpServersTab.tsx", "SkillSourcesTab.tsx"]) {
    const source = readSource(file);

    assert.doesNotMatch(source, /generateProfileBindingProposal/);
    assert.doesNotMatch(source, /applyProfileBindingProposal/);
  }
});

test("global MCP ids already present in a profile remain removable", () => {
  const source = readSource("AgentProfilesTab.tsx");

  assert.match(
    source,
    /disabled=\{\s*saving\s*\|\|\s*\(\s*!isPerAgent\s*&&\s*!selectedMcpIds\.has\(s\.id\)\s*\)\s*\}/,
  );
});
