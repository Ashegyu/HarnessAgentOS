import type { Artifact, Step, ValidationRun } from "@harness/core";
import { selectCurrentValidationEvidence, type CurrentValidationWorkspace } from "@harness/core";
import type { EvidenceBundle } from "./quality-types";

const isChangeEvidence = (artifact: Artifact): boolean => {
  if (artifact.kind !== "diff") return false;
  // Only the complete host-owned snapshot format can establish no change.
  // Unknown/legacy diffs and truncated scans remain conservative.
  const summary = artifact.summary ?? "";
  const emptyHostSnapshot = artifact.uri?.startsWith(`harness:workspace-change/${artifact.taskRunId}/`) &&
    /^# Workspace change evidence\r?\n/.test(summary) &&
    /^Changed files: 0\r?$/m.test(summary) &&
    /^Snapshot file list truncated: no\r?$/m.test(summary) &&
    /## Changed-file manifest\r?\n\s*No file changes observed\.\r?\n\s*## Text diffs\s*$/.test(summary);
  return !emptyHostSnapshot;
};

/** Only host-owned terminal runner steps establish execution, never model prose. */
export const collectEvidence = (
  steps: Step[], artifacts: Artifact[], runs: ValidationRun[] = [], current?: CurrentValidationWorkspace,
): EvidenceBundle => {
  const changes = artifacts.filter(isChangeEvidence);
  const bundle: EvidenceBundle = {
    steps, artifacts, testEvidence: [], buildEvidence: [], smokeEvidence: [],
    diffArtifactIds: changes.map(row => row.id),
  };
  if (!current) return bundle;
  const taskRunId = steps[0]?.taskRunId ?? artifacts[0]?.taskRunId ?? runs[0]?.taskRunId ?? "";
  const selected = selectCurrentValidationEvidence({ taskRunId, runs, steps, artifacts, current });
  bundle.unverifiedReasons = selected.unverifiedReasons;
  for (const run of selected.runs) {
    const evidence = {
      passed: run.status === "completed" && run.exitCode === 0,
      ...(run.artifactId ? { artifactId: run.artifactId } : {}),
    };
    if (run.kinds.includes("test")) bundle.testEvidence.push(evidence);
    if (run.kinds.includes("build")) bundle.buildEvidence.push(evidence);
    if (run.kinds.includes("smoke")) bundle.smokeEvidence.push(evidence);
  }
  return bundle;
};
