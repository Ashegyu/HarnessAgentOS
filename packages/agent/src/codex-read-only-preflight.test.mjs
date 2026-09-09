import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexMcpServerNames } from "./codex-read-only-preflight.ts";

test("MCP inventory retains enabled and disabled server identities without secret fields", () => {
  assert.deepEqual(parseCodexMcpServerNames(JSON.stringify([
    { name: "a", enabled: true, env: { SECRET: "do-not-return" } },
    { name: "b.with.dots", enabled: false }, { name: "a", enabled: true },
  ])), ["a", "b.with.dots"]);
});
for (const raw of ['{}', 'null', '[null]', '[{"name":""}]', 'broken']) {
  test(`MCP inventory rejects malformed shape: ${raw}`, () => {
    assert.throws(() => parseCodexMcpServerNames(raw));
  });
}
