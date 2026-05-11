export type ArtifactKind =
  | "plan"
  | "diff"
  | "log"
  | "test_result"
  | "quality_report"
  | "orchestration_plan"
  | "file"
  | "snapshot";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "plan",
  "diff",
  "log",
  "test_result",
  "quality_report",
  "orchestration_plan",
  "file",
  "snapshot",
];

export interface Artifact {
  id: string;
  taskRunId: string;
  stepId?: string;
  kind: ArtifactKind;
  title: string;
  uri: string;
  summary?: string;
  createdAt: string;
}

export interface CreateArtifactInput {
  id?: string;
  taskRunId: string;
  stepId?: string;
  kind: ArtifactKind;
  title: string;
  uri: string;
  summary?: string;
}
