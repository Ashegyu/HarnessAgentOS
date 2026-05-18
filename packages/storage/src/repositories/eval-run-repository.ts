import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export type EvalRunSuite = "capability" | "regression" | "safety" | "all";
export type EvalRunStatus = "running" | "passed" | "failed" | "partial";

export interface EvalRunSummaryPayload {
  readonly runId: string;
  readonly suite: EvalRunSuite;
  readonly mode?: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly cases: ReadonlyArray<unknown>;
  readonly status: EvalRunStatus;
  readonly harnessRevisionSha?: string;
}

export interface EvalRunRecord {
  readonly id: string;
  readonly suite: EvalRunSuite;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: EvalRunStatus;
  readonly summary: EvalRunSummaryPayload;
  readonly harnessSha: string | null;
  readonly createdAt: string;
}

export interface CreateEvalRunInput {
  readonly suite: EvalRunSuite;
  readonly harnessSha?: string;
}

export interface FinishEvalRunInput {
  readonly status: Exclude<EvalRunStatus, "running">;
  readonly summary: EvalRunSummaryPayload;
}

export interface ListEvalRunFilters {
  readonly suite?: EvalRunSuite;
  readonly status?: EvalRunStatus;
  readonly limit?: number;
}

export interface EvalRunRepository {
  create(input: CreateEvalRunInput): Promise<EvalRunRecord>;
  finish(id: string, input: FinishEvalRunInput): Promise<EvalRunRecord>;
  get(id: string): Promise<EvalRunRecord | null>;
  list(filters?: ListEvalRunFilters): Promise<ReadonlyArray<EvalRunRecord>>;
  delete(id: string): Promise<void>;
}

interface EvalRunRow {
  id: string;
  suite: EvalRunSuite;
  started_at: string;
  finished_at: string | null;
  status: EvalRunStatus;
  summary_json: string;
  harness_sha: string | null;
  created_at: string;
}

export class SqliteEvalRunRepository implements EvalRunRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(input: CreateEvalRunInput): Promise<EvalRunRecord> {
    const id = newId("evalRun");
    const startedAt = nowIso();
    const summary: EvalRunSummaryPayload = {
      runId: id,
      suite: input.suite,
      startedAt,
      finishedAt: null,
      cases: [],
      status: "running",
      ...(input.harnessSha ? { harnessRevisionSha: input.harnessSha } : {}),
    };
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO eval_runs(
           id, suite, started_at, finished_at, status, summary_json,
           harness_sha, created_at
         ) VALUES(
           @id, @suite, @startedAt, NULL, 'running', @summaryJson,
           @harnessSha, @createdAt
         )`,
      )
      .run({
        id,
        suite: input.suite,
        startedAt,
        summaryJson: JSON.stringify(summary),
        harnessSha: input.harnessSha ?? null,
        createdAt,
      });
    return this.requireRow(id);
  }

  async finish(id: string, input: FinishEvalRunInput): Promise<EvalRunRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`EvalRun ${id} not found`);
    const finishedAt = input.summary.finishedAt ?? nowIso();
    const summary: EvalRunSummaryPayload = {
      ...input.summary,
      runId: id,
      suite: current.suite,
      startedAt: current.startedAt,
      finishedAt,
      status: input.status,
    };
    this.db
      .prepare(
        `UPDATE eval_runs
            SET finished_at = @finishedAt,
                status = @status,
                summary_json = @summaryJson
          WHERE id = @id`,
      )
      .run({
        id,
        finishedAt,
        status: input.status,
        summaryJson: JSON.stringify(summary),
      });
    return this.requireRow(id);
  }

  async get(id: string): Promise<EvalRunRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM eval_runs WHERE id = ?`)
      .get(id) as EvalRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async list(filters: ListEvalRunFilters = {}): Promise<ReadonlyArray<EvalRunRecord>> {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filters.suite !== undefined) {
      where.push("suite = ?");
      values.push(filters.suite);
    }
    if (filters.status !== undefined) {
      where.push("status = ?");
      values.push(filters.status);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 500));
    values.push(limit);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM eval_runs
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY datetime(started_at) DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...values) as EvalRunRow[];
    return rows.map(rowToRecord);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM eval_runs WHERE id = ?`).run(id);
  }

  private async requireRow(id: string): Promise<EvalRunRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`EvalRun ${id} not found`);
    return record;
  }
}

const rowToRecord = (row: EvalRunRow): EvalRunRecord => ({
  id: row.id,
  suite: row.suite,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  summary: JSON.parse(row.summary_json) as EvalRunSummaryPayload,
  harnessSha: row.harness_sha,
  createdAt: row.created_at,
});
