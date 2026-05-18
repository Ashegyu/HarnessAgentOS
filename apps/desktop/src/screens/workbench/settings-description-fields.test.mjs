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

const readWorkbenchCss = () =>
  readFileSync(join(__dirname, "workbench.css"), "utf8");

const cssRule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  assert.ok(match?.groups?.body, `${selector} rule must exist`);
  return match.groups.body;
};

test("thread sidebar descriptions wrap instead of clipping", () => {
  const css = readWorkbenchCss();

  for (const selector of [
    ".thread-list__title",
    ".thread-list__target",
    ".thread-list__pipeline",
  ]) {
    const rule = cssRule(css, selector);
    assert.match(
      rule,
      /white-space:\s*normal;/,
      `${selector} should allow multiple lines`,
    );
    assert.match(
      rule,
      /overflow-wrap:\s*anywhere;/,
      `${selector} should break long uninterrupted text`,
    );
    assert.doesNotMatch(
      rule,
      /text-overflow:\s*ellipsis;/,
      `${selector} should not hide text behind ellipsis`,
    );
    assert.doesNotMatch(
      rule,
      /-webkit-line-clamp:/,
      `${selector} should not clamp thread text`,
    );
  }
});

test("settings prose descriptions wrap instead of clipping", () => {
  const css = readWorkbenchCss();

  for (const selector of [
    ".agent-profiles-tab__role-help p",
    ".agent-profiles-tab__role-help span",
    ".agent-profiles-tab__migrate-body p",
    ".pipeline-intent-filter__summary",
    ".pipeline-recommendation__header p",
  ]) {
    const rule = cssRule(css, selector);
    assert.match(
      rule,
      /overflow-wrap:\s*anywhere;/,
      `${selector} should wrap long descriptions`,
    );
  }
});
