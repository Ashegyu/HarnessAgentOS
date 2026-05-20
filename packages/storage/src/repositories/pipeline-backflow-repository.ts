import type {
  CreatePipelineBackflowAttemptInput,
  CreatePipelineBackflowEventInput,
  PipelineBackflowActivityInput,
  PipelineBackflowActivityPage,
  PipelineBackflowAttempt,
  PipelineBackflowAttemptStatus,
  PipelineBackflowEvent,
  PipelineBackflowTrigger,
  UpdatePipelineBackflowAttemptPatch,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface PipelineBackflowAttemptCountInput {
  taskRunId: string;
  planId: string;
  ruleId: string;
  trigger: PipelineBackflowTrigger;
}

export interface PipelineBackflowRepository {
  createAttempt(
    input: CreatePipelineBackflowAttemptInput,
  ): Promise<PipelineBackflowAttempt>;
  updateAttempt(
    id: string,
    patch: UpdatePipelineBackflowAttemptPatch,
  ): Promise<PipelineBackflowAttempt>;
  getAttempt(id: string): Promise<PipelineBackflowAttempt | null>;
  listByTaskRun(taskRunId: string): Promise<PipelineBackflowAttempt[]>;
  countAttempts(input: PipelineBackflowAttemptCountInput): Promise<number>;
  createEvent(
    input: CreatePipelineBackflowEventInput,
  ): Promise<PipelineBackflowEvent>;
  listActivityEvents(
    input: PipelineBackflowActivityInput,
  ): Promise<PipelineBackflowActivityPage>;
}

interface PipelineBackflowAttemptRow {
  id: string;
  task_run_id: string;
  plan_id: string;
  rule_id: string;
  trigger: PipelineBackflowTrigger;
  target_step_id: string;
  retry_step_id: string;
  max_attempts: number;
  attempt_index: number;
  status: PipelineBackflowAttemptStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PipelineBackflowEventRow {
  id: string;
  task_run_id: string;
  attempt_id: string;
  event_type: PipelineBackflowEvent["eventType"];
  event_status: PipelineBackflowAttemptStatus;
  summary: string;
  reason: string | null;
  payload_json: string;
  event_created_at: string;
  thread_id: string;
  thread_title: string;
  task_run_user_request: string;
  task_run_status: PipelineBackflowEvent["taskRunStatus"];
  rule_id: string;
  trigger: PipelineBackflowTrigger;
  target_step_id: string;
  retry_step_id: string;
  attempt_index: number;
}

const rowToAttempt = (
  row: PipelineBackflowAttemptRow,
): PipelineBackflowAttempt => {
  const attempt: PipelineBackflowAttempt = {
    id: row.id,
    taskRunId: row.task_run_id,
    planId: row.plan_id,
    ruleId: row.rule_id,
    trigger: row.trigger,
    targetStepId: row.target_step_id,
    retryStepId: row.retry_step_id,
    maxAttempts: row.max_attempts,
    attemptIndex: row.attempt_index,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.reason !== null) attempt.reason = row.reason;
  if (row.completed_at !== null) attempt.completedAt = row.completed_at;
  return attempt;
};

const parsePayload = (raw: string): Record<string, unknown> => {
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

const rowToEvent = (row: PipelineBackflowEventRow): PipelineBackflowEvent => {
  const event: PipelineBackflowEvent = {
    id: row.id,
    taskRunId: row.task_run_id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    taskRunUserRequest: row.task_run_user_request,
    taskRunStatus: row.task_run_status,
    attemptId: row.attempt_id,
    ruleId: row.rule_id,
    trigger: row.trigger,
    targetStepId: row.target_step_id,
    retryStepId: row.retry_step_id,
    attemptIndex: row.attempt_index,
    eventType: row.event_type,
    status: row.event_status,
    summary: row.summary,
    payload: parsePayload(row.payload_json),
    createdAt: row.event_created_at,
  };
  if (row.reason !== null) event.reason = row.reason;
  return event;
};

export class SqlitePipelineBackflowRepository
  implements PipelineBackflowRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async createAttempt(
    input: CreatePipelineBackflowAttemptInput,
  ): Promise<PipelineBackflowAttempt> {
    const now = nowIso();
    const attempt: PipelineBackflowAttempt = {
      id: newId("pipelineBackflow"),
      taskRunId: input.taskRunId,
      planId: input.planId,
      ruleId: input.ruleId,
      trigger: input.trigger,
      targetStepId: input.targetStepId,
      retryStepId: input.retryStepId,
      maxAttempts: input.maxAttempts,
      attemptIndex: this.nextAttemptIndex(input),
      status: input.status ?? "running",
      createdAt: now,
      updatedAt: now,
    };
    if (input.reason !== undefined) attempt.reason = input.reason;
    this.db
      .prepare(
        `INSERT INTO pipeline_backflow_attempts(
           id, task_run_id, plan_id, rule_id, trigger, target_step_id,
           retry_step_id, max_attempts, attempt_index, status, reason,
           created_at, updated_at, completed_at
         ) VALUES(
           @id, @taskRunId, @planId, @ruleId, @trigger, @targetStepId,
           @retryStepId, @maxAttempts, @attemptIndex, @status, @reason,
           @createdAt, @updatedAt, @completedAt
         )`,
      )
      .run({
        id: attempt.id,
        taskRunId: attempt.taskRunId,
        planId: attempt.planId,
        ruleId: attempt.ruleId,
        trigger: attempt.trigger,
        targetStepId: attempt.targetStepId,
        retryStepId: attempt.retryStepId,
        maxAttempts: attempt.maxAttempts,
        attemptIndex: attempt.attemptIndex,
        status: attempt.status,
        reason: attempt.reason ?? null,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
        completedAt: attempt.completedAt ?? null,
      });
    return attempt;
  }

  async updateAttempt(
    id: string,
    patch: UpdatePipelineBackflowAttemptPatch,
  ): Promise<PipelineBackflowAttempt> {
    const current = await this.getAttempt(id);
    if (!current) throw new Error(`PipelineBackflowAttempt ${id} not found`);
    const next: PipelineBackflowAttempt = {
      ...current,
      updatedAt: nowIso(),
    };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.reason !== undefined) {
      if (patch.reason === null) delete next.reason;
      else next.reason = patch.reason;
    }
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) delete next.completedAt;
      else next.completedAt = patch.completedAt;
    }
    this.db
      .prepare(
        `UPDATE pipeline_backflow_attempts SET
           status = @status,
           reason = @reason,
           updated_at = @updatedAt,
           completed_at = @completedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        status: next.status,
        reason: next.reason ?? null,
        updatedAt: next.updatedAt,
        completedAt: next.completedAt ?? null,
      });
    return next;
  }

  async getAttempt(id: string): Promise<PipelineBackflowAttempt | null> {
    const row = this.db
      .prepare(`SELECT * FROM pipeline_backflow_attempts WHERE id = ?`)
      .get(id) as PipelineBackflowAttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async listByTaskRun(taskRunId: string): Promise<PipelineBackflowAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM pipeline_backflow_attempts
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, id ASC`,
      )
      .all(taskRunId) as PipelineBackflowAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async countAttempts(input: PipelineBackflowAttemptCountInput): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM pipeline_backflow_attempts
         WHERE task_run_id = ?
           AND plan_id = ?
           AND rule_id = ?
           AND trigger = ?
           AND status != 'max_attempts_reached'`,
      )
      .get(
        input.taskRunId,
        input.planId,
        input.ruleId,
        input.trigger,
      ) as { count: number };
    return row.count;
  }

  async createEvent(
    input: CreatePipelineBackflowEventInput,
  ): Promise<PipelineBackflowEvent> {
    const attempt = await this.getAttempt(input.attemptId);
    if (!attempt) {
      throw new Error(`PipelineBackflowAttempt ${input.attemptId} not found`);
    }
    if (attempt.taskRunId !== input.taskRunId) {
      throw new Error(
        `PipelineBackflowAttempt ${input.attemptId} does not belong to TaskRun ${input.taskRunId}`,
      );
    }
    const id = newId("pipelineBackflowEvent");
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO pipeline_backflow_events(
           id, task_run_id, attempt_id, event_type, status, summary,
           reason, payload_json, created_at
         ) VALUES(
           @id, @taskRunId, @attemptId, @eventType, @status, @summary,
           @reason, @payloadJson, @createdAt
         )`,
      )
      .run({
        id,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        eventType: input.eventType,
        status: input.status,
        summary: input.summary,
        reason: input.reason ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt,
      });
    const event = this.getActivityEventById(id);
    if (!event) {
      throw new Error(`PipelineBackflowEvent ${id} not found after insert`);
    }
    return event;
  }

  async listActivityEvents(
    input: PipelineBackflowActivityInput,
  ): Promise<PipelineBackflowActivityPage> {
    const limit = clampPageSize(input.limit);
    const offset = clampOffset(input.offset);
    const where = buildActivityEventWhere(input);
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM pipeline_backflow_events e
         INNER JOIN pipeline_backflow_attempts a ON a.id = e.attempt_id
         INNER JOIN task_runs tr ON tr.id = e.task_run_id
         INNER JOIN threads th ON th.id = tr.thread_id
         WHERE ${where.sql}`,
      )
      .get(...where.params) as { total: number };
    const rows = this.db
      .prepare(
        `${ACTIVITY_SELECT}
         WHERE ${where.sql}
         ORDER BY datetime(e.created_at) DESC, e.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset) as PipelineBackflowEventRow[];
    const total = totalRow.total;
    return {
      items: rows.map(rowToEvent),
      total,
      limit,
      offset,
      hasNext: offset + limit < total,
    };
  }

  private nextAttemptIndex(
    input: Pick<
      CreatePipelineBackflowAttemptInput,
      "taskRunId" | "planId" | "ruleId" | "trigger"
    >,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_index), -1) + 1 AS nextIndex
         FROM pipeline_backflow_attempts
         WHERE task_run_id = ?
           AND plan_id = ?
           AND rule_id = ?
           AND trigger = ?`,
      )
      .get(
        input.taskRunId,
        input.planId,
        input.ruleId,
        input.trigger,
      ) as { nextIndex: number };
    return row.nextIndex;
  }

  private getActivityEventById(id: string): PipelineBackflowEvent | null {
    const row = this.db
      .prepare(`${ACTIVITY_SELECT} WHERE e.id = ?`)
      .get(id) as PipelineBackflowEventRow | undefined;
    return row ? rowToEvent(row) : null;
  }
}

const ACTIVITY_SELECT = `SELECT
  e.id,
  e.task_run_id,
  e.attempt_id,
  e.event_type,
  e.status AS event_status,
  e.summary,
  e.reason,
  e.payload_json,
  e.created_at AS event_created_at,
  th.id AS thread_id,
  th.title AS thread_title,
  tr.user_request AS task_run_user_request,
  tr.status AS task_run_status,
  a.rule_id,
  a.trigger,
  a.target_step_id,
  a.retry_step_id,
  a.attempt_index
FROM pipeline_backflow_events e
INNER JOIN pipeline_backflow_attempts a ON a.id = e.attempt_id
INNER JOIN task_runs tr ON tr.id = e.task_run_id
INNER JOIN threads th ON th.id = tr.thread_id`;

const clampPageSize = (value: number): number => {
  if (!Number.isInteger(value)) return 25;
  return Math.max(1, Math.min(100, value));
};

const clampOffset = (value: number): number => {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, value);
};

const buildActivityEventWhere = (
  input: PipelineBackflowActivityInput,
): { sql: string; params: unknown[] } => {
  const clauses = ["1 = 1"];
  const params: unknown[] = [];
  if (input.sinceIso) {
    clauses.push("e.created_at >= ?");
    params.push(input.sinceIso);
  }
  if (input.untilIso) {
    clauses.push("e.created_at < ?");
    params.push(input.untilIso);
  }
  return { sql: clauses.join(" AND "), params };
};
