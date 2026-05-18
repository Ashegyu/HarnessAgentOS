import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readWorkbenchCss = () =>
  readFileSync(join(__dirname, "workbench.css"), "utf8");

const readFeatureHelpSource = () =>
  readFileSync(join(__dirname, "FeatureHelpButton.tsx"), "utf8");

const cssRule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`));
  assert.ok(match?.groups?.body, `${selector} rule must exist`);
  return match.groups.body;
};

test("feature help popovers render at viewport layer to avoid clipping", () => {
  const source = readFeatureHelpSource();

  assert.match(
    source,
    /createPortal/,
    "feature help popover should escape clipped drawer/dialog containers",
  );
  assert.match(
    source,
    /document\.body/,
    "feature help popover should mount at document body level",
  );
  assert.match(
    source,
    /getBoundingClientRect/,
    "feature help popover should position itself near the trigger button",
  );
});

test("feature help popover text wraps inside the viewport", () => {
  const css = readWorkbenchCss();
  const popover = cssRule(css, ".feature-help__popover");
  const summary = cssRule(css, ".feature-help__summary");
  const detail = cssRule(css, ".feature-help__detail");
  const location = cssRule(css, ".feature-help__location");

  assert.match(popover, /position:\s*fixed;/);
  assert.match(popover, /overflow-y:\s*auto;/);
  assert.match(popover, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(popover, /position:\s*absolute;/);
  for (const [name, body] of [
    ["summary", summary],
    ["detail", detail],
    ["location", location],
  ]) {
    assert.match(
      body,
      /overflow-wrap:\s*anywhere;/,
      `${name} text should wrap instead of clipping`,
    );
  }
});
