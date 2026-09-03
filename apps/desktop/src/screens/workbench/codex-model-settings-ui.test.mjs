import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (name) => readFileSync(join(__dirname, name), "utf8");

for (const file of ["SettingsPanel.tsx", "AgentProfilesTab.tsx"]) {
  test(`${file} renders the shared Codex model and reasoning catalogs`, () => {
    const source = readSource(file);
    assert.match(source, /CODEX_MODELS\.map/);
    assert.match(source, /AGENT_REASONING_EFFORTS\.map/);
    assert.doesNotMatch(source, /<option value="(?:auto|claude)"/);
    assert.doesNotMatch(source, /claude-sonnet/);
  });
}

test("Agent profile provider is fixed to Codex instead of being selectable", () => {
  const source = readSource("AgentProfilesTab.tsx");
  assert.doesNotMatch(source, /updateDraft\("provider"/);
  assert.match(source, /Codex 전용/);
});
