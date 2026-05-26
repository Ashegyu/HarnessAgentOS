import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readWorkbenchCss = () =>
  readFileSync(join(__dirname, "workbench.css"), "utf8");

const readGlobalCss = () =>
  readFileSync(join(__dirname, "../../app/global.css"), "utf8");

const cssRule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  assert.ok(match?.groups?.body, `${selector} rule must exist`);
  return match.groups.body;
};

test("workbench selects use explicit themed colors in dark mode", () => {
  const css = readWorkbenchCss();

  assert.doesNotMatch(
    css,
    /--bg-base/,
    "select/dropdown surfaces should not depend on an undefined background token",
  );

  const pipelineSelect = cssRule(css, ".conversation-input__pipeline-select");
  assert.match(pipelineSelect, /background:\s*var\(--bg-input\);/);
  assert.match(pipelineSelect, /color:\s*var\(--text-primary\);/);

  const threadSelect = cssRule(
    css,
    ".thread-create-form__field input,\n.thread-create-form__field select",
  );
  assert.match(threadSelect, /background:\s*var\(--bg-input\);/);
  assert.match(threadSelect, /color:\s*var\(--text-primary\);/);
  assert.match(threadSelect, /text-transform:\s*none;/);

  const selectOptions = cssRule(
    css,
    ".thread-create-form__field select option,\n.conversation-input__pipeline-select option,\n.conversation-input__orch-field select option",
  );
  assert.match(selectOptions, /background:\s*var\(--bg-input\);/);
  assert.match(selectOptions, /color:\s*var\(--text-primary\);/);
});

test("native dropdowns receive the active theme color scheme", () => {
  const css = readGlobalCss();

  const root = cssRule(css, ":root");
  const light = cssRule(css, '[data-theme="light"]');

  assert.match(root, /color-scheme:\s*dark;/);
  assert.match(light, /color-scheme:\s*light;/);
});
