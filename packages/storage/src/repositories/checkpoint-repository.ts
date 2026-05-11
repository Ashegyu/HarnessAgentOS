import type { Checkpoint, CreateCheckpointInput } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToCheckpoint } from "./row-mappers.ts";

export interface CheckpointRepository {
  create(input: CreateCheckpointInput): Promise<Checkpoint>;
  listByTaskRun(taskRunId: string): Promise<Checkpoint[]>;
  get(id: string): Promise<Checkpoint | null>;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateCheckpointInput): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      id: newId("checkpoint"),
      taskRunId: input.taskRunId,
      stepId: input.stepId,
      reason: input.reason,
      stateRef: input.stateRef,
      summary: input.summary,
      createdAt: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO checkpoints(id, task_run_id, step_id, reason, state_ref, summary, created_at)
         VALUES(@id, @taskRunId, @stepId, @reason, @stateRef, @summary, @createdAt)`,
      )
      .run(checkpoint);

    return checkpoint;
  }

  async listByTaskRun(taskRunId: string): Promise<Checkpoint[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, step_id, reason, state_ref, summary, created_at
         FROM checkpoints WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, id ASC`,
      )
      .all(taskRunId) as Parameters<typeof rowToCheckpoint>[0][];
    return rows.map(rowToCheckpoint);
  }

  async get(id: string): Promise<Checkpoint | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, step_id, reason, state_ref, summary, created_at
         FROM checkpoints WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToCheckpoint>[0] | undefined;
    return row ? rowToCheckpoint(row) : null;
  }
}
