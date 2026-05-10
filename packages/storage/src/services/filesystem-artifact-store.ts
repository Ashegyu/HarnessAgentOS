import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  EXT_BY_KIND,
  buildArtifactUri,
  type ArtifactKind,
  type ArtifactStore,
} from "@harness/core";

export interface FilesystemArtifactStoreOptions {
  /** Absolute root directory, e.g. `app.getPath("userData")/artifacts`. */
  rootDir: string;
}

const artifactPath = (
  rootDir: string,
  taskRunId: string,
  artifactId: string,
  kind: ArtifactKind,
): string => join(rootDir, taskRunId, `${artifactId}.${EXT_BY_KIND[kind]}`);

export class FilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly options: FilesystemArtifactStoreOptions) {}

  async write(input: {
    taskRunId: string;
    artifactId: string;
    kind: ArtifactKind;
    content: string;
  }): Promise<{ uri: string; absolutePath: string }> {
    const absolutePath = artifactPath(
      this.options.rootDir,
      input.taskRunId,
      input.artifactId,
      input.kind,
    );
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, "utf8");
    return {
      uri: buildArtifactUri(input.taskRunId, input.artifactId),
      absolutePath,
    };
  }

  async read(input: {
    taskRunId: string;
    artifactId: string;
    kind: ArtifactKind;
  }): Promise<string> {
    const p = artifactPath(
      this.options.rootDir,
      input.taskRunId,
      input.artifactId,
      input.kind,
    );
    return readFile(p, "utf8");
  }

  resolveUriPath(uri: string, kind: ArtifactKind): string | null {
    const m = uri.match(/^artifact:\/\/([^/]+)\/(.+)$/);
    if (!m || !m[1] || !m[2]) return null;
    return artifactPath(this.options.rootDir, m[1], m[2], kind);
  }
}
