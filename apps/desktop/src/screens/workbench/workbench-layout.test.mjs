import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_LAYOUT_LIMITS,
  createWorkbenchLayoutStyle,
  readStoredPanelWidth,
  resizePanelWidth,
} from "./workbench-layout.ts";

test("stored panel widths reject non-finite values and clamp to safe bounds", () => {
  assert.equal(readStoredPanelWidth(null, "thread"), 272);
  assert.equal(readStoredPanelWidth("not-a-number", "thread"), 272);
  assert.equal(readStoredPanelWidth("Infinity", "context"), 380);
  assert.equal(readStoredPanelWidth("120", "thread"), 180);
  assert.equal(readStoredPanelWidth("900", "context"), 600);
  assert.equal(readStoredPanelWidth("316", "thread"), 316);
});

test("layout style centralizes every shell offset as a CSS custom property", () => {
  assert.deepEqual(createWorkbenchLayoutStyle(300, 420), {
    "--rail-width": "60px",
    "--status-bar-height": "32px",
    "--thread-drawer-width": "300px",
    "--context-drawer-width": "420px",
    "--main-workspace-min": "400px",
  });

  assert.deepEqual(WORKBENCH_LAYOUT_LIMITS.thread, {
    min: 180,
    max: 400,
    default: 272,
  });
  assert.deepEqual(WORKBENCH_LAYOUT_LIMITS.context, {
    min: 280,
    max: 600,
    default: 380,
  });
});

test("keyboard resizing moves in one spacing step and preserves panel bounds", () => {
  assert.equal(resizePanelWidth(272, "thread", 1), 288);
  assert.equal(resizePanelWidth(272, "thread", -1), 256);
  assert.equal(resizePanelWidth(180, "thread", -1), 180);
  assert.equal(resizePanelWidth(600, "context", 1), 600);
});
