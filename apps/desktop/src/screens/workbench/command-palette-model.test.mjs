import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterCommandPaletteItems,
  movePaletteSelection,
} from "./command-palette-model.ts";

const noop = () => {};
const items = [
  {
    id: "tab:quality",
    group: "tab",
    title: "Quality",
    subtitle: "Open QA tab",
    keywords: ["qa"],
    run: noop,
  },
  {
    id: "settings:open",
    group: "settings",
    title: "Settings",
    subtitle: "Open settings",
    run: noop,
  },
  {
    id: "thread:alpha",
    group: "thread",
    title: "Alpha project",
    subtitle: "Thread",
    run: noop,
  },
];

test("filterCommandPaletteItems keeps original order for an empty query", () => {
  assert.deepEqual(
    filterCommandPaletteItems(items, "").map((item) => item.id),
    ["tab:quality", "settings:open", "thread:alpha"],
  );
});

test("filterCommandPaletteItems ranks exact matches first", () => {
  assert.equal(filterCommandPaletteItems(items, "settings")[0].id, "settings:open");
});

test("filterCommandPaletteItems matches partial and fuzzy queries", () => {
  assert.equal(filterCommandPaletteItems(items, "qual")[0].id, "tab:quality");
  assert.equal(filterCommandPaletteItems(items, "ap")[0].id, "thread:alpha");
});

test("movePaletteSelection wraps keyboard navigation", () => {
  assert.equal(movePaletteSelection(0, "down", 3), 1);
  assert.equal(movePaletteSelection(2, "down", 3), 0);
  assert.equal(movePaletteSelection(0, "up", 3), 2);
  assert.equal(movePaletteSelection(4, "up", 0), 0);
});
