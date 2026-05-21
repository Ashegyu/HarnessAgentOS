import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = () => readFileSync(join(__dirname, "PipelinesTab.tsx"), "utf8");

test("PipelinesTab edits backflow as an agent-owned connection", () => {
  const source = readSource();

  assert.match(source, /Backflow 연결/);
  assert.match(source, /handleAddBackflowRuleForStep/);
  assert.match(source, /retryStepId:\s*retry\.id/);
  assert.match(source, /retryStepId:\s*step\.id/);
  assert.match(source, /const earlierSteps = draft\.steps\.slice\(0, i\)/);
  assert.doesNotMatch(source, /<legend>Backflow Rules<\/legend>/);
});
