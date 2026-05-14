import type { Artifact, Step } from "@harness/core";
import type { EvidenceBundle } from "./quality-types";

const BUILD_HINT = /\bbuild\b/i;
const TEST_HINT = /\btest\b|jest|vitest|pytest|mocha|cargo\s+test/i;
const SMOKE_HINT = /\bsmoke\b|\be2e\b|\bplaywright\b|\bcypress\b/i;
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
  const smokeEvidence: { passed: boolean; artifactId?: string }[] = [];
  const diffArtifactIds: string[] = [];

  for (const a of artifacts) {
    if (a.kind === "diff") diffArtifactIds.push(a.id);
    if (a.kind === "test_result") {
      const summary = `${a.title} ${a.summary ?? ""}`;
      const passed = !EXIT_FAIL.test(summary) && (EXIT_OK.test(summary) || /\bpass(?:ed)?\b/i.test(summary));
      const ev: { passed: boolean; artifactId?: string } = { passed, artifactId: a.id };
      testEvidence.push(ev);
      if (SMOKE_HINT.test(summary)) {
        smokeEvidence.push(ev);
      }
    } else if (a.kind === "log") {
      const summary = `${a.title} ${a.summary ?? ""}`;
      const exitedOk = EXIT_OK.test(summary);
      const exitedFail = EXIT_FAIL.test(summary);
      if (BUILD_HINT.test(summary) && (exitedOk || exitedFail)) {
        buildEvidence.push({
          passed: exitedOk && !exitedFail,
          artifactId: a.id,
        });
      }
      if (SMOKE_HINT.test(summary) && (exitedOk || exitedFail)) {
        smokeEvidence.push({
          passed: exitedOk && !exitedFail,
          artifactId: a.id,
        });
      }
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
    if (
      (s.kind === "shell" || s.kind === "test") &&
      SMOKE_HINT.test(summary) &&
      s.status !== "pending"
    ) {
      smokeEvidence.push({ passed: s.status === "succeeded" });
    }
  }

  return {
    steps,
    artifacts,
    testEvidence,
    buildEvidence,
    smokeEvidence,
    diffArtifactIds,
  };
};
