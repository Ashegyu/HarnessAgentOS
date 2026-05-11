import type { Artifact, CreateArtifactInput } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToArtifact } from "./row-mappers.ts";

export interface ArtifactRepository {
  create(input: CreateArtifactInput): Promise<Artifact>;
  listByTaskRun(taskRunId: string): Promise<Artifact[]>;
  get(id: string): Promise<Artifact | null>;
}

export class SqliteArtifactRepository implements ArtifactRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateArtifactInput): Promise<Artifact> {
    const artifact: Artifact = {
      id: input.id ?? newId("artifact"),
      taskRunId: input.taskRunId,
      kind: input.kind,
      title: input.title,
      uri: input.uri,
      createdAt: nowIso(),
    };
    if (input.stepId !== undefined) artifact.stepId = input.stepId;
    if (input.summary !== undefined) artifact.summary = input.summary;

    this.db
      .prepare(
        `INSERT INTO artifacts(id, task_run_id, step_id, kind, title, uri, summary, created_at)
         VALUES(@id, @taskRunId, @stepId, @kind, @title, @uri, @summary, @createdAt)`,
      )
      .run({
        id: artifact.id,
        taskRunId: artifact.taskRunId,
        stepId: artifact.stepId ?? null,
        kind: artifact.kind,
        title: artifact.title,
        uri: artifact.uri,
        summary: artifact.summary ?? null,
        createdAt: artifact.createdAt,
      });

    return artifact;
  }

  async listByTaskRun(taskRunId: string): Promise<Artifact[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, step_id, kind, title, uri, summary, created_at
         FROM artifacts WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, id ASC`,
      )
      .all(taskRunId) as Parameters<typeof rowToArtifact>[0][];
    return rows.map(rowToArtifact);
  }

  async get(id: string): Promise<Artifact | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, step_id, kind, title, uri, summary, created_at
         FROM artifacts WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToArtifact>[0] | undefined;
    return row ? rowToArtifact(row) : null;
  }
}
