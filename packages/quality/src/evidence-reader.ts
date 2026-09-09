import type { Artifact, Step } from "@harness/core";
import type { EvidenceBundle } from "./quality-types";

const BUILD_HINT = /\bbuild\b/i;
const TEST_HINT = /\btest\b|jest|vitest|pytest|mocha|cargo\s+test/i;
const SMOKE_HINT = /\bsmoke\b|\be2e\b|\bplaywright\b|\bcypress\b/i;

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
export const collectEvidence = (steps: Step[], artifacts: Artifact[]): EvidenceBundle => {
  const changes = artifacts.filter(isChangeEvidence);
  const bundle: EvidenceBundle = {
    steps, artifacts, testEvidence: [], buildEvidence: [], smokeEvidence: [],
    diffArtifactIds: changes.map(row => row.id),
  };
  const stepById = new Map(steps.map(step => [step.id, step]));
  // An unlinked diff has no verifiable ordering: do not reuse an older check.
  const changeIndexes = changes.map(row =>
    row.stepId ? stepById.get(row.stepId)?.index ?? Infinity : Infinity,
  );
  const lastChangeIndex = Math.max(-1, ...changeIndexes,
    ...steps.filter(step => step.kind === "edit" && step.status === "succeeded").map(step => step.index));

  for (const step of steps) {
    if (step.kind !== "shell" && step.kind !== "test") continue;
    if (step.status !== "succeeded" && step.status !== "failed") continue;
    if (step.index <= lastChangeIndex) continue;
    // inputSummary/title are the command recorded by the runner. Its output
    // can contain arbitrary strings, including misleading test/build keywords.
    const command = `${step.title} ${step.inputSummary ?? ""}`;
    const related = artifacts.filter(row => row.stepId === step.id && row.taskRunId === step.taskRunId);
    const artifact = related.find(row => row.kind === "test_result")
      ?? related.find(row => row.kind === "log");
    const evidence = {
      passed: step.status === "succeeded",
      ...(artifact ? { artifactId: artifact.id } : {}),
    };
    if (step.kind === "test" || TEST_HINT.test(command)) bundle.testEvidence.push(evidence);
    if (step.kind === "shell" && BUILD_HINT.test(command)) bundle.buildEvidence.push(evidence);
    if (SMOKE_HINT.test(command)) bundle.smokeEvidence.push(evidence);
  }
  return bundle;
};
