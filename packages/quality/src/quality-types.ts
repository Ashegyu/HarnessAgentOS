import type { Artifact, Step } from "@harness/core";

export interface EvidenceBundle {
  steps: Step[];
  artifacts: Artifact[];
  testEvidence: { passed: boolean; artifactId?: string }[];
  buildEvidence: { passed: boolean; artifactId?: string }[];
  diffArtifactIds: string[];
}

export interface QualityRequirement {
  requireBuild?: boolean;
  requireTests?: boolean;
  requireSmoke?: boolean;
}
