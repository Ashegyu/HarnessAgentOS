import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("LearningPanel owns task-independent instinct and skill management", () => {
  const source = readSource("LearningPanel.tsx");

  assert.match(source, /import \{ InstinctPanel \}/);
  assert.match(source, /import \{ SkillSourcesTab \}/);
  assert.match(source, /<InstinctPanel \/>/);
  assert.match(source, /<SkillSourcesTab \/>/);
});

test("RightPanel no longer exposes Instinct as a TaskRun-only tab", () => {
  const source = readSource("RightPanel.tsx");

  assert.doesNotMatch(source, /InstinctPanel/);
  assert.doesNotMatch(source, /id: "instinct"/);
  assert.doesNotMatch(source, /right-panel-panel-instinct/);
});

test("SlimRail exposes Learning without selected TaskRun gating", () => {
  const source = readSource("SlimRail.tsx");
  const clickIndex = source.indexOf("onClick={onOpenLearning}");
  assert.notEqual(clickIndex, -1, "Learning rail button must call onOpenLearning");

  const learningButtonIndex = source.lastIndexOf("<button", clickIndex);
  assert.notEqual(learningButtonIndex, -1, "Learning rail button must exist");

  const learningButtonEnd = source.indexOf("</button>", learningButtonIndex);
  assert.notEqual(learningButtonEnd, -1, "Learning rail button must close");
  const learningButton = source.slice(learningButtonIndex, learningButtonEnd);

  assert.match(learningButton, /onClick=\{onOpenLearning\}/);
  assert.match(learningButton, /aria-label="Learning 열기"/);
  assert.doesNotMatch(learningButton, /disabled=\{!hasSelectedTaskRun\}/);
});

test("WorkbenchShell wires the Learning overlay and command", () => {
  const source = readSource("WorkbenchShell.tsx");

  assert.match(source, /import \{ LearningPanel \}/);
  assert.match(source, /const \[learningOpen, setLearningOpen\]/);
  assert.match(source, /id: "learning:open"/);
  assert.match(source, /group: "learning"/);
  assert.match(source, /<LearningPanel onClose=\{\(\) => setLearningOpen\(false\)\} \/>/);
});
