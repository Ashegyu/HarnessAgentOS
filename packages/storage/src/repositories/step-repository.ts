import type { CreateStepInput, Step, StepStatus } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToStep } from "./row-mappers.ts";

export interface StepRepository {
  create(input: CreateStepInput): Promise<Step>;
  listByTaskRun(taskRunId: string): Promise<Step[]>;
  get(id: string): Promise<Step | null>;
  updateStatus(
    id: string,
    status: StepStatus,
    patch?: { outputSummary?: string },
  ): Promise<Step>;
}

export class SqliteStepRepository implements StepRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateStepInput): Promise<Step> {
    const step: Step = {
      id: newId("step"),
      taskRunId: input.taskRunId,
      index: input.index,
      kind: input.kind,
      title: input.title,
      status: input.status ?? "pending",
    };
    if (input.inputSummary !== undefined) step.inputSummary = input.inputSummary;

    this.db
      .prepare(
        `INSERT INTO steps(id, task_run_id, step_index, kind, title, status, input_summary, output_summary, started_at, finished_at)
         VALUES(@id, @taskRunId, @stepIndex, @kind, @title, @status, @inputSummary, NULL, NULL, NULL)`,
      )
      .run({
        id: step.id,
        taskRunId: step.taskRunId,
        stepIndex: step.index,
        kind: step.kind,
        title: step.title,
        status: step.status,
        inputSummary: step.inputSummary ?? null,
      });

    return step;
  }

  async listByTaskRun(taskRunId: string): Promise<Step[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, step_index, kind, title, status, input_summary, output_summary, started_at, finished_at
         FROM steps WHERE task_run_id = ?
         ORDER BY step_index ASC, id ASC`,
      )
      .all(taskRunId) as Parameters<typeof rowToStep>[0][];
    return rows.map(rowToStep);
  }

  async get(id: string): Promise<Step | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, step_index, kind, title, status, input_summary, output_summary, started_at, finished_at
         FROM steps WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToStep>[0] | undefined;
    return row ? rowToStep(row) : null;
  }

  async updateStatus(
    id: string,
    status: StepStatus,
    patch?: { outputSummary?: string },
  ): Promise<Step> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Step ${id} not found`);
    const now = nowIso();
    const next: Step = { ...existing, status };
    if (patch?.outputSummary !== undefined) next.outputSummary = patch.outputSummary;
    if (status === "running" && !next.startedAt) next.startedAt = now;
    if (status === "succeeded" || status === "failed" || status === "skipped") {
      next.finishedAt = now;
    }
    this.db
      .prepare(
        `UPDATE steps
         SET status=@status, output_summary=@outputSummary, started_at=@startedAt, finished_at=@finishedAt
         WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        outputSummary: next.outputSummary ?? null,
        startedAt: next.startedAt ?? null,
        finishedAt: next.finishedAt ?? null,
      });
    return next;
  }
}
