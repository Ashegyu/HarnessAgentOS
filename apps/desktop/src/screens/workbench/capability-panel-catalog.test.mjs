import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("CapabilityPanel renders the registered capability catalog, not only matching suggestions", () => {
  const source = readSource("CapabilityPanel.tsx");

  assert.match(source, /const renderCatalog = \(\): JSX\.Element/);
  assert.match(source, /catalog\.capabilities\.map\(\(capability\) =>/);
  assert.match(source, /등록된 capability/);
  assert.match(
    source,
    /전체 registry에는 등록되어 있지만 현재 요청과 매칭되지 않을 수\s+있습니다/,
  );
});
