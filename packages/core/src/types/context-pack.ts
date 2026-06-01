import type { ObservationRecallOutcome } from "./learning-trace.ts";

export type ContextPackSourceKind =
  | "instinct"
  | "capability"
  | "quality_gate"
  | "artifact"
  | "thread_task"
  | "repo_context"
  | "pinned_observation";

export interface ContextPackSource {
  kind: ContextPackSourceKind;
  id: string;
  title: string;
  reason?: string;
}

export interface ContextPackSection {
  title: string;
  itemCount: number;
  sourceIds: string[];
}

export interface ContextPackCounts {
  instincts: number;
  capabilities: number;
  qualityRisks: number;
  threadTasks: number;
  recentArtifacts: number;
  repoFiles: number;
  pinnedObservations: number;
}

export interface ContextPackPinnedObservationOutcome
  extends ObservationRecallOutcome {
  observationId: string;
}

export interface ContextPack {
  taskRunId: string;
  profileId?: string;
  profileName?: string;
  counts: ContextPackCounts;
  sections: ContextPackSection[];
  sources: ContextPackSource[];
  promptInclusion: {
    instinctIds: string[];
    capabilityIds: string[];
    qualityGateId?: string;
    threadTaskRunIds: string[];
    artifactIds: string[];
    repoFiles: string[];
    pinnedObservationIds: string[];
    pinnedObservationOutcomes: ContextPackPinnedObservationOutcome[];
  };
}
