import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("HarnessPackagesTab exposes import/list/remove without execution actions", () => {
  const source = readSource("HarnessPackagesTab.tsx");

  assert.match(source, /window\.harness\.harnessPackages\.list/);
  assert.match(source, /window\.harness\.app\.selectDirectory/);
  assert.match(source, /window\.harness\.harnessPackages\.importDirectory/);
  assert.match(source, /window\.harness\.harnessPackages\.repair/);
  assert.match(source, /window\.harness\.harnessPackages\.previewPipelineDraft/);
  assert.match(source, /window\.harness\.pipeline\.create/);
  assert.match(source, /window\.harness\.harnessPackages\.remove/);
  assert.match(source, /summarizeHarnessPackage/);
  assert.match(source, /primaryHarnessPackageIssue/);
  assert.match(source, /harnessAgentBindingCandidates/);
  assert.match(source, /harnessWorkflowStepRows/);
  assert.match(source, /repairInputFromDraft/);
  assert.match(source, /validateHarnessWorkflowRepairDraft/);
  assert.match(source, /harness-packages-tab__step-list/);
  assert.match(source, /harness-packages-tab__repair/);
  assert.doesNotMatch(source, /harnessPackages\.run/);
  assert.doesNotMatch(source, /harnessPackages\.apply/);
  assert.doesNotMatch(source, /harnessPackages\.export/);
  assert.doesNotMatch(source, /window\.harness\.orchestration\.runApproved/);
  assert.doesNotMatch(source, /window\.harness\.runner\.executeApproved/);
});

test("SettingsPanel includes the Harnesses tab", () => {
  const source = readSource("SettingsPanel.tsx");

  assert.match(source, /HarnessPackagesTab/);
  assert.match(source, /harnessPackages/);
  assert.match(source, /Harnesses/);
});
