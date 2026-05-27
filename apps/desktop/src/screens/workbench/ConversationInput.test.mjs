import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("ConversationInput keeps orchestration selectors visible with disabled empty states", () => {
  const source = readSource("ConversationInput.tsx");

  assert.doesNotMatch(source, /\{orchEnabled && pipelines\.length > 0 &&/);
  assert.doesNotMatch(source, /\{orchEnabled && harnessRouteOptions\.length > 0 &&/);
  assert.match(source, /저장된 Pipeline 없음/);
  assert.match(source, /저장된 Binding Set 없음/);
  assert.match(source, /disabled=\{submitting \|\| !orchEnabled \|\| pipelines\.length === 0\}/);
  assert.match(
    source,
    /disabled=\{\s*submitting \|\| !orchEnabled \|\| harnessRouteOptions\.length === 0\s*\}/,
  );
});
