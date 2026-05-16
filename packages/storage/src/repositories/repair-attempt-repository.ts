import type { RepairAttempt, RepairAttemptStatus } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface CreateRepairAttemptInput {
  taskRunId: string;
  qualityGateId: string;
  failureSignature: string;
  status?: RepairAttemptStatus;
}

export interface UpdateRepairAttemptPatch {
  status?: RepairAttemptStatus;
  invocationId?: string | null;
  generatedApprovalIds?: string[];
}

export interface RepairAttemptRepository {
  create(input: CreateRepairAttemptInput): Promise<RepairAttempt>;
  update(id: string, patch: UpdateRepairAttemptPatch): Promise<RepairAttempt>;
  listByTaskRun(taskRunId: string): Promise<RepairAttempt[]>;
  get(id: string): Promise<RepairAttempt | null>;
}

interface RepairAttemptRow {
  id: string;
  task_run_id: string;
  quality_gate_id: string;
  attempt_index: number;
  failure_signature: string;
  status: RepairAttemptStatus;
  invocation_id: string | null;
  generated_approval_ids_json: string;
  created_at: string;
  updated_at: string;
}

const parseStringArray = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
};

const rowToRepairAttempt = (row: RepairAttemptRow): RepairAttempt => {
  const attempt: RepairAttempt = {
    id: row.id,
    taskRunId: row.task_run_id,
    qualityGateId: row.quality_gate_id,
    attemptIndex: row.attempt_index,
    failureSignature: row.failure_signature,
    status: row.status,
    generatedApprovalIds: parseStringArray(row.generated_approval_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.invocation_id !== null) attempt.invocationId = row.invocation_id;
  return attempt;
};

export class SqliteRepairAttemptRepository implements RepairAttemptRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(input: CreateRepairAttemptInput): Promise<RepairAttempt> {
    const now = nowIso();
    const attemptIndex = this.nextAttemptIndex(input.taskRunId);
    const attempt: RepairAttempt = {
      id: newId("repairAttempt"),
      taskRunId: input.taskRunId,
      qualityGateId: input.qualityGateId,
      attemptIndex,
      failureSignature: input.failureSignature,
      status: input.status ?? "planned",
      generatedApprovalIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO repair_attempts(
           id, task_run_id, quality_gate_id, attempt_index, failure_signature,
           status, invocation_id, generated_approval_ids_json, created_at, updated_at
         ) VALUES(
           @id, @taskRunId, @qualityGateId, @attemptIndex, @failureSignature,
           @status, NULL, @generatedApprovalIdsJson, @createdAt, @updatedAt
         )`,
      )
      .run({
        id: attempt.id,
        taskRunId: attempt.taskRunId,
        qualityGateId: attempt.qualityGateId,
        attemptIndex: attempt.attemptIndex,
        failureSignature: attempt.failureSignature,
        status: attempt.status,
        generatedApprovalIdsJson: JSON.stringify(attempt.generatedApprovalIds),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      });
    return attempt;
  }

  async update(id: string, patch: UpdateRepairAttemptPatch): Promise<RepairAttempt> {
    const current = await this.get(id);
    if (!current) throw new Error(`RepairAttempt ${id} not found`);
    const next: RepairAttempt = {
      ...current,
      updatedAt: nowIso(),
    };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.invocationId !== undefined) {
      if (patch.invocationId === null) delete next.invocationId;
      else next.invocationId = patch.invocationId;
    }
    if (patch.generatedApprovalIds !== undefined) {
      next.generatedApprovalIds = patch.generatedApprovalIds;
    }
    this.db
      .prepare(
        `UPDATE repair_attempts SET
           status = @status,
           invocation_id = @invocationId,
           generated_approval_ids_json = @generatedApprovalIdsJson,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        status: next.status,
        invocationId: next.invocationId ?? null,
        generatedApprovalIdsJson: JSON.stringify(next.generatedApprovalIds),
        updatedAt: next.updatedAt,
      });
    return next;
  }

  async listByTaskRun(taskRunId: string): Promise<RepairAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM repair_attempts
         WHERE task_run_id = ?
         ORDER BY attempt_index ASC, id ASC`,
      )
      .all(taskRunId) as RepairAttemptRow[];
    return rows.map(rowToRepairAttempt);
  }

  async get(id: string): Promise<RepairAttempt | null> {
    const row = this.db
      .prepare(`SELECT * FROM repair_attempts WHERE id = ?`)
      .get(id) as RepairAttemptRow | undefined;
    return row ? rowToRepairAttempt(row) : null;
  }

  private nextAttemptIndex(taskRunId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_index), -1) + 1 AS nextIndex
         FROM repair_attempts
         WHERE task_run_id = ?`,
      )
      .get(taskRunId) as { nextIndex: number };
    return row.nextIndex;
  }
}
