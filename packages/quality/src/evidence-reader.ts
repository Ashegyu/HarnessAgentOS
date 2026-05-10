import type { Artifact, Step } from "@harness/core";
import type { EvidenceBundle } from "./quality-types";

const BUILD_HINT = /\bbuild\b/i;
const TEST_HINT = /\btest\b|jest|vitest|pytest|mocha|cargo\s+test/i;
const EXIT_OK = /\bexit\s*=\s*0\b/i;
const EXIT_FAIL = /\bexit\s*=\s*[1-9]/i;

/**
 * Phase 4 evidence reader. Walks the steps and artifacts associated
 * with a TaskRun and classifies them into build/test/diff evidence.
 *
 * Pure helper — no DB or FS access. Caller passes in already-loaded
 * arrays from LocalStateService.
 */
export const collectEvidence = (
  steps: Step[],
  artifacts: Artifact[],
): EvidenceBundle => {
  const testEvidence: { passed: boolean; artifactId?: string }[] = [];
  const buildEvidence: { passed: boolean; artifactId?: string }[] = [];
  const diffArtifactIds: string[] = [];

  for (const a of artifacts) {
    if (a.kind === "diff") diffArtifactIds.push(a.id);
    if (a.kind === "test_result") {
      const summary = a.summary ?? "";
      const passed = !EXIT_FAIL.test(summary) && (EXIT_OK.test(summary) || /\bpass(?:ed)?\b/i.test(summary));
      const ev: { passed: boolean; artifactId?: string } = { passed, artifactId: a.id };
      testEvidence.push(ev);
    }
  }

  for (const s of steps) {
    const summary = `${s.title} ${s.outputSummary ?? ""} ${s.inputSummary ?? ""}`;
    if (s.kind === "test") {
      const ev: { passed: boolean; artifactId?: string } = {
        passed: s.status === "succeeded",
      };
      testEvidence.push(ev);
    } else if (s.kind === "shell" && BUILD_HINT.test(summary)) {
      buildEvidence.push({ passed: s.status === "succeeded" });
    } else if (s.kind === "shell" && TEST_HINT.test(summary) && s.status !== "pending") {
      testEvidence.push({ passed: s.status === "succeeded" });
    }
  }

  return {
    steps,
    artifacts,
    testEvidence,
    buildEvidence,
    diffArtifactIds,
  };
};
