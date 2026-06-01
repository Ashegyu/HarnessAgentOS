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

test("LearnerPanel exposes read-only context recall", () => {
  const source = readSource("LearnerPanel.tsx");
  const recommendationSource = readSource("RecommendationCard.tsx");
  const shellSource = readSource("WorkbenchShell.tsx");

  assert.match(source, /window\.harness\.learner\.recallContext/);
  assert.match(source, /window\.harness\.learner\.summarizeContextOutcomes/);
  assert.match(shellSource, /window\.harness\.learner\.recordContextDecision/);
  assert.match(source, /관련 context/);
  assert.match(source, /context observability/);
  assert.match(source, /contextDecisionCount/);
  assert.match(source, /recentContextDecisions/);
  assert.match(source, /verifiedContextPackCount/);
  assert.match(source, /pendingContextPackCount/);
  assert.match(source, /검증 context pack/);
  assert.match(source, /pinnedObservationIds/);
  assert.match(source, /onPinnedObservationToggle/);
  assert.match(source, /outcome/);
  assert.match(source, /성과/);
  assert.match(source, /재사용 주의/);
  assert.match(source, /reuseRiskText/);
  assert.match(source, /최근 outcome/);
  assert.match(source, /recentOutcomes/);
  assert.match(source, /outcomeSource/);
  assert.match(source, /출처: quality/);
  assert.match(source, /주의 context/);
  assert.match(source, /riskObservations/);
  assert.match(source, /최근 context pack/);
  assert.match(source, /recentContextPacks/);
  assert.match(recommendationSource, /recommendedContext/);
  assert.match(recommendationSource, /추천 context/);
  assert.match(recommendationSource, /onPinnedObservationToggle/);
  assert.doesNotMatch(source, /recordObservation/);
});

test("InstinctPanel exposes read-only candidate evidence", () => {
  const source = readSource("InstinctPanel.tsx");

  assert.match(source, /window\.harness\.instinct\.getCandidateEvidence/);
  assert.match(source, /근거 observation/);
  assert.match(source, /candidateEvidenceById/);
  assert.doesNotMatch(source, /createObservation/);
});

test("WorkbenchShell wires the Learning overlay and command", () => {
  const source = readSource("WorkbenchShell.tsx");

  assert.match(source, /import \{ LearningPanel \}/);
  assert.match(source, /const \[learningOpen, setLearningOpen\]/);
  assert.match(source, /id: "learning:open"/);
  assert.match(source, /group: "learning"/);
  assert.match(source, /taskRun=\{\s*taskRunDetail\.kind === "ready"\s*\?\s*taskRunDetail\.detail\.taskRun\s*:\s*null\s*\}/);
  assert.match(source, /approvals=\{\s*taskRunDetail\.kind === "ready"\s*\?\s*taskRunDetail\.detail\.approvals\s*:\s*\[\]\s*\}/);
  assert.match(source, /pinnedObservationContextsByTaskRunId/);
  assert.match(source, /pinnedObservationContexts:\s*pinnedObservationContextsByTaskRunId\[taskRunId\]/);
  assert.match(source, /onApprovalCreated=\{handleQualityChanged\}/);
  assert.match(source, /onClose=\{\(\) => setLearningOpen\(false\)\}/);
});
