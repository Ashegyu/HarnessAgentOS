import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnsiSgr } from "./ansi-sgr.ts";

test("parses SGR reset without surfacing escape text", () => {
  assert.deepEqual(parseAnsiSgr("ok\u001b[0m1"), [
    { text: "ok", style: {} },
    { text: "1", style: {} },
  ]);
});

test("applies inverse video until reset", () => {
  assert.deepEqual(parseAnsiSgr("a\u001b[7m<>\u001b[0mz"), [
    { text: "a", style: {} },
    { text: "<>", style: { inverse: true } },
    { text: "z", style: {} },
  ]);
});

test("parses escaped output rendered with a visible left-arrow escape marker", () => {
  assert.deepEqual(parseAnsiSgr("←[7m<>←[0m"), [
    { text: "<>", style: { inverse: true } },
  ]);
});

test("applies standard, bright, and rgb colors", () => {
  assert.deepEqual(
    parseAnsiSgr("\u001b[31mred\u001b[92mgreen\u001b[38;2;1;2;3mrgb\u001b[0m"),
    [
      { text: "red", style: { fg: "#ef4444" } },
      { text: "green", style: { fg: "#4ade80" } },
      { text: "rgb", style: { fg: "rgb(1, 2, 3)" } },
    ],
  );
});

test("strips non-SGR CSI sequences", () => {
  assert.deepEqual(parseAnsiSgr("a\u001b[2Kb"), [
    { text: "a", style: {} },
    { text: "b", style: {} },
  ]);
});
