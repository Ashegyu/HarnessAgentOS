import type { Artifact, Step } from "@harness/core";

export interface EvidenceBundle {
  steps: Step[];
  artifacts: Artifact[];
  testEvidence: { passed: boolean; artifactId?: string }[];
  buildEvidence: { passed: boolean; artifactId?: string }[];
  smokeEvidence: { passed: boolean; artifactId?: string }[];
  diffArtifactIds: string[];
  unverifiedReasons?: string[];
}

export interface QualityRequirement {
  verifiedReportDelivery?: boolean;
  requireBuild?: boolean;
  requireTests?: boolean;
  requireSmoke?: boolean;
}
