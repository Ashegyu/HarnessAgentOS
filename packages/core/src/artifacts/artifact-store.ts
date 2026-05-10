import type { ArtifactKind } from "../types";

/**
 * Phase 3 artifact filesystem store interface. Concrete fs-backed
 * implementation lives in @harness/storage; this file stays Node-free
 * so the renderer can import it safely (the interface flows through
 * IPC but the implementation does not).
 *
 * Per docs/architecture/state-and-artifact-architecture.md, artifact
 * metadata lives in the SQLite `artifacts` table while large bodies
 * are written under `userData/artifacts/{taskRunId}/{id}.{ext}`.
 */

export const EXT_BY_KIND: Record<ArtifactKind, string> = {
  plan: "md",
  diff: "diff",
  log: "log",
  test_result: "log",
  quality_report: "json",
  orchestration_plan: "md",
  file: "txt",
  snapshot: "json",
};

export const buildArtifactUri = (
  taskRunId: string,
  artifactId: string,
): string => `artifact://${taskRunId}/${artifactId}`;

export interface ArtifactStore {
  write(input: {
    taskRunId: string;
    artifactId: string;
    kind: ArtifactKind;
    content: string;
  }): Promise<{ uri: string; absolutePath: string }>;

  read(input: {
    taskRunId: string;
    artifactId: string;
    kind: ArtifactKind;
  }): Promise<string>;

  /**
   * Resolve an `artifact://` URI back to a filesystem path. Phase 4
   * uses this for evidence reading. Returns null for malformed URIs.
   */
  resolveUriPath(uri: string, kind: ArtifactKind): string | null;
}
