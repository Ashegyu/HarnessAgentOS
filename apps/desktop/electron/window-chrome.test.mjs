import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(__dirname, "main.ts"), "utf8");
const workbenchCss = readFileSync(
  join(__dirname, "../src/screens/workbench/workbench.css"),
  "utf8",
);

test("main window integrates the Windows title bar with the dark workbench", () => {
  assert.match(mainSource, /titleBarStyle:\s*"hidden"/);
  assert.match(mainSource, /titleBarOverlay:\s*\{/);
  assert.match(mainSource, /color:\s*"#090e14"/);
  assert.match(mainSource, /symbolColor:\s*"#edf3f8"/);
  assert.match(mainSource, /height:\s*52/);
});

test("main window removes the detached native application menu", () => {
  assert.match(mainSource, /autoHideMenuBar:\s*true/);
  assert.match(mainSource, /win\.removeMenu\(\)/);
});

test("workbench exposes practical drag surfaces without swallowing controls", () => {
  assert.doesNotMatch(workbenchCss, /\.workbench::before\s*\{/);
  assert.match(
    workbenchCss,
    /\.slim-rail,[^}]*\.thread-sidebar\s*>\s*\.panel-header,[^}]*\.conversation-workbench\s*>\s*\.panel-header,[^}]*\.right-panel\s*>\s*\.panel-header,[^}]*\.conversation-workbench\s*>\s*\.hero-empty\s*\{[^}]*-webkit-app-region:\s*drag/s,
  );
  assert.match(
    workbenchCss,
    /\.workbench\s+:where\([^)]*button[^)]*input[^)]*select[^)]*textarea[^)]*a[^)]*\)\s*\{[^}]*-webkit-app-region:\s*no-drag/s,
  );
});

test("notification target stays clear of window controls", () => {
  assert.match(
    workbenchCss,
    /right:\s*calc\(\s*100vw\s*-\s*\(env\(titlebar-area-x,\s*0px\)\s*\+\s*env\(titlebar-area-width,\s*100vw\)\)\s*\+\s*12px\s*\)/,
  );
});
