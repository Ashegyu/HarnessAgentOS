import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const descriptionFieldFiles = [
  "AgentProfilesTab.tsx",
  "PipelinesTab.tsx",
  "McpServersTab.tsx",
  "SkillSourcesTab.tsx",
];

test("settings description fields use multiline textarea controls", () => {
  for (const file of descriptionFieldFiles) {
    const source = readFileSync(join(__dirname, file), "utf8");
    const label = '<span className="settings-field__label">설명</span>';
    const labelIndex = source.indexOf(label);
    assert.notEqual(labelIndex, -1, `${file} must have a description field`);

    const fieldEnd = source.indexOf("</label>", labelIndex);
    assert.notEqual(fieldEnd, -1, `${file} description field must close`);
    const fieldSource = source.slice(labelIndex, fieldEnd);
    assert.match(
      fieldSource,
      /<textarea\b/,
      `${file} description should wrap instead of clipping in a single-line input`,
    );
    assert.doesNotMatch(
      fieldSource,
      /<input\b/,
      `${file} description should not render as a single-line input`,
    );
  }
});
