import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("LearningPanel owns instinct, capability, learner, and skill management", () => {
  const source = readSource("LearningPanel.tsx");

  assert.match(source, /import \{ InstinctPanel \}/);
  assert.match(source, /import \{ CapabilityPanel \}/);
  assert.match(source, /import \{ LearnerPanel \}/);
  assert.match(source, /import \{ SkillSourcesTab \}/);
  assert.match(source, /<InstinctPanel \/>/);
  assert.match(source, /<CapabilityPanel/);
  assert.match(source, /<LearnerPanel/);
  assert.match(source, /<SkillSourcesTab \/>/);
  assert.doesNotMatch(source, /BudgetOverviewTab/);
});

test("RightPanel no longer exposes learning surfaces as TaskRun-only tabs", () => {
  const source = readSource("RightPanel.tsx");

  assert.doesNotMatch(source, /InstinctPanel/);
  assert.doesNotMatch(source, /CapabilityPanel/);
  assert.doesNotMatch(source, /LearnerPanel/);
  assert.doesNotMatch(source, /id: "instinct"/);
  assert.doesNotMatch(source, /id: "capabilities"/);
  assert.doesNotMatch(source, /right-panel-panel-instinct/);
  assert.doesNotMatch(source, /right-panel-panel-capabilities/);
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
  assert.match(source, /taskRun=\{\s*taskRunDetail\.kind === "ready"\s*\?\s*taskRunDetail\.detail\.taskRun\s*:\s*null\s*\}/);
  assert.match(source, /approvals=\{\s*taskRunDetail\.kind === "ready"\s*\?\s*taskRunDetail\.detail\.approvals\s*:\s*\[\]\s*\}/);
  assert.match(source, /onApprovalCreated=\{handleQualityChanged\}/);
  assert.match(source, /onClose=\{\(\) => setLearningOpen\(false\)\}/);
});
