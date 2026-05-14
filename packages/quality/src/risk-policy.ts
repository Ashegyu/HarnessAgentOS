import type { EvidenceBundle, QualityRequirement } from "./quality-types";

/**
 * Phase 4 risk policy. Pure decisions about what counts as a risk
 * given the evidence and the caller's requirements. Translates into
 * the `knownRisks: string[]` field on a QualityGateResult.
 */
export const collectRisks = (
  evidence: EvidenceBundle,
  req: QualityRequirement,
): string[] => {
  const risks: string[] = [];

  if (req.requireTests && evidence.testEvidence.length === 0) {
    risks.push("required tests were not run");
  }
  if (
    evidence.testEvidence.length > 0 &&
    evidence.testEvidence.some((e) => !e.passed)
  ) {
    risks.push("tests failed in this run");
  }

  if (req.requireBuild && evidence.buildEvidence.length === 0) {
    risks.push("required build evidence is missing");
  }
  if (
    evidence.buildEvidence.length > 0 &&
    evidence.buildEvidence.some((e) => !e.passed)
  ) {
    risks.push("build failed in this run");
  }

  if (req.requireSmoke && evidence.smokeEvidence.length === 0) {
    risks.push("smoke evidence is missing");
  }
  if (
    evidence.smokeEvidence.length > 0 &&
    evidence.smokeEvidence.some((e) => !e.passed)
  ) {
    risks.push("smoke failed in this run");
  }

  if (
    evidence.diffArtifactIds.length > 0 &&
    evidence.testEvidence.length === 0
  ) {
    risks.push(
      "files were changed but no test evidence accompanies them",
    );
  }

  return risks;
};
