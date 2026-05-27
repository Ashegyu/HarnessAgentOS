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
  assert.match(source, /window\.harness\.harnessPackages\.previewExport/);
  assert.match(source, /window\.harness\.harnessPackages\.proposeExport/);
  assert.match(source, /window\.harness\.harnessPackages\.previewPipelineDraft/);
  assert.match(source, /window\.harness\.pipeline\.create/);
  assert.match(source, /window\.harness\.harnessPackages\.remove/);
  assert.match(source, /window\.harness\.agent\.checkProviders/);
  assert.match(source, /window\.harness\.mcp\.list/);
  assert.match(source, /window\.harness\.skillSource\.list/);
  assert.match(source, /window\.harness\.capability\.list/);
  assert.match(source, /summarizeHarnessPackage/);
  assert.match(source, /primaryHarnessPackageIssue/);
  assert.match(source, /harnessAgentBindingCandidates/);
  assert.match(source, /harnessWorkflowStepRows/);
  assert.match(source, /assessHarnessBindingReadiness/);
  assert.match(source, /repairInputFromDraft/);
  assert.match(source, /validateHarnessWorkflowRepairDraft/);
  assert.match(source, /harness-packages-tab__step-list/);
  assert.match(source, /harness-packages-tab__repair/);
  assert.match(source, /harness-packages-tab__readiness/);
  assert.match(source, /Export Preview/);
  assert.match(source, /Propose Write/);
  assert.doesNotMatch(source, /harnessPackages\.run/);
  assert.doesNotMatch(source, /harnessPackages\.apply/);
  assert.doesNotMatch(source, /harnessPackages\.writeSource/);
  assert.doesNotMatch(source, /window\.harness\.orchestration\.runApproved/);
  assert.doesNotMatch(source, /window\.harness\.runner\.executeApproved/);
});

test("HarnessPackagesTab sends the readiness provider snapshot with pipeline preview", () => {
  const source = readSource("HarnessPackagesTab.tsx");

  assert.match(
    source,
    /previewPipelineDraft\(\{[\s\S]*readinessList\.kind === "ready"[\s\S]*providers: readinessList\.providers[\s\S]*\}\)/,
  );
});

test("HarnessPackagesTab renders export proposal approval batch details", () => {
  const source = readSource("HarnessPackagesTab.tsx");

  assert.match(source, /HarnessPackageExportProposalResult/);
  assert.match(source, /setExportProposal\(result\)/);
  assert.match(source, /Approval Batch/);
  assert.match(source, /exportProposal\.targetDir/);
  assert.match(source, /exportProposal\.taskRun\.status/);
  assert.match(source, /exportProposal\.approvals\.map/);
  assert.match(source, /approval\.proposedAction\?\.filePatch\?\.path/);
});

test("SettingsPanel includes the Harnesses tab", () => {
  const source = readSource("SettingsPanel.tsx");

  assert.match(source, /HarnessPackagesTab/);
  assert.match(source, /harnessPackages/);
  assert.match(source, /Harnesses/);
});
