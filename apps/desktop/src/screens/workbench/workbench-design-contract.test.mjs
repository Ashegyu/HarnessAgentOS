import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const here = new URL(".", import.meta.url);
const globalCss = readFileSync(new URL("../../app/global.css", here), "utf8");
const workbenchCss = readFileSync(new URL("./workbench.css", here), "utf8");
const shellSource = readFileSync(new URL("./WorkbenchShell.tsx", here), "utf8");
const inputSource = readFileSync(new URL("./ConversationInput.tsx", here), "utf8");
const railSource = readFileSync(new URL("./SlimRail.tsx", here), "utf8");
const rightPanelSource = readFileSync(new URL("./RightPanel.tsx", here), "utf8");
const allCss = `${globalCss}\n${workbenchCss}`;

test("every workbench design token has a concrete definition", () => {
  const definitions = new Set(
    [...allCss.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]),
  );
  const usages = new Set(
    [...allCss.matchAll(/var\(--([a-zA-Z0-9-]+)/g)].map((match) => match[1]),
  );
  const missing = [...usages].filter((token) => !definitions.has(token)).sort();

  assert.deepEqual(missing, []);
});

test("shell offsets are CSS-grid aligned instead of hard-coded pixel math", () => {
  assert.match(shellSource, /createWorkbenchLayoutStyle\(sidebarWidth, rightPanelWidth\)/);
  assert.match(shellSource, /workbench-resizer--thread/);
  assert.match(shellSource, /workbench-resizer--context/);
  assert.doesNotMatch(shellSource, /left:\s*64\s*\+\s*sidebarWidth/);
  assert.doesNotMatch(shellSource, /right:\s*rightPanelWidth/);

  assert.match(
    workbenchCss,
    /minmax\(var\(--thread-drawer-min\), var\(--thread-drawer-current\)\)/,
  );
  assert.match(
    workbenchCss,
    /minmax\(var\(--main-workspace-min\), 1fr\)/,
  );
  assert.match(
    workbenchCss,
    /minmax\(var\(--context-drawer-min\), var\(--context-drawer-current\)\)/,
  );
});

test("refined workbench retains keyboard focus and reduced-motion support", () => {
  assert.match(globalCss, /:focus-visible/);
  assert.match(workbenchCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(workbenchCss, /\.hero-empty__eyebrow/);
});

test("primary workbench surfaces share the refined icon and composer system", () => {
  assert.match(inputSource, /conversation-input__context-row/);
  assert.match(railSource, /WorkbenchIcon/);
  assert.match(rightPanelSource, /right-panel-empty/);
  assert.match(rightPanelSource, /WorkbenchIcon/);
});
