import type { RepairAttempt, RepairAttemptStatus } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { qualityFailureSignature, type QualityFailureGate, type FailedQualityChecker } from "../quality-failure-signature.ts";

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

export type RepairAttemptReservation =
  | { reserved: true; attempt: RepairAttempt }
  | { reserved: false; reason: "limit" | "repeated_signature" | "stale_gate" | "unverifiable_failure" };

export type ReserveRepairAttemptInput = Omit<CreateRepairAttemptInput, "failureSignature"> & { maxAttempts: number };

export interface RepairAttemptRepository {
  create(input: CreateRepairAttemptInput): Promise<RepairAttempt>;
  reserve(input: ReserveRepairAttemptInput): Promise<RepairAttemptReservation>;
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

const strictStringArray = (raw: string): string[] | null => {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every(item => typeof item === "string") ? value : null;
  } catch { return null; }
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
    return this.createSync(input);
  }

  async reserve(input: ReserveRepairAttemptInput): Promise<RepairAttemptReservation> {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 0) {
      throw new RangeError("Repair maxAttempts must be a non-negative integer");
    }
    // Own the write lock before reading policy state. Two services/connections
    // cannot both inspect an old count and then reserve the same failure.
    return this.db.transaction((): RepairAttemptReservation => {
      const latestGate = this.db.prepare(
        `SELECT id, status FROM quality_gate_results WHERE task_run_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(input.taskRunId) as { id: string; status: string } | undefined;
      if (!latestGate || latestGate.id !== input.qualityGateId || latestGate.status === "passed") {
        return { reserved: false, reason: "stale_gate" };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM repair_attempts WHERE task_run_id=?")
        .get(input.taskRunId) as { count: number };
      if (count.count >= input.maxAttempts) return { reserved: false, reason: "limit" };
      const prior = this.db.prepare(
        "SELECT quality_gate_id FROM repair_attempts WHERE task_run_id = ?",
      ).all(input.taskRunId) as { quality_gate_id: string }[];
      const current = this.failureIdentity(input.taskRunId, input.qualityGateId);
      if (!current) return { reserved: false, reason: "unverifiable_failure" };
      for (const attempt of prior) {
        // Re-read the canonical source for every format of historical hash.
        // A signature algorithm upgrade must not grant an extra model call.
        const previous = this.failureIdentity(input.taskRunId, attempt.quality_gate_id);
        if (!previous) return { reserved: false, reason: "unverifiable_failure" };
        const repeated = current.hasCheckers && previous.hasCheckers
          ? current.hasFailureDetails&&previous.hasFailureDetails
            ? current.signature===previous.signature
            : current.baseSignature===previous.baseSignature
          : current.basis === previous.basis;
        if (repeated) return { reserved: false, reason: "repeated_signature" };
      }
      return { reserved: true, attempt: this.createSync({ ...input, failureSignature: current.signature }) };
    }).immediate();
  }

  private failureIdentity(taskRunId: string, gateId: string): {
    basis: string; signature: string; baseSignature:string;hasCheckers: boolean;hasFailureDetails:boolean;
  } | null {
    const row = this.db.prepare(`SELECT status, known_risks_json, evidence_artifact_ids_json,
      build_passed, tests_passed, smoke_passed FROM quality_gate_results WHERE id=? AND task_run_id=?`)
      .get(gateId, taskRunId) as {
        status: QualityFailureGate["status"]; known_risks_json: string; evidence_artifact_ids_json: string;
        build_passed: number | null; tests_passed: number | null; smoke_passed: number | null;
      } | undefined;
    if (!row || !["failed", "warning", "not_run"].includes(row.status)) return null;
    const knownRisks = strictStringArray(row.known_risks_json);
    const evidence = strictStringArray(row.evidence_artifact_ids_json);
    if (!knownRisks || !evidence || [row.build_passed, row.tests_passed, row.smoke_passed]
      .some(value => value !== null && value !== 0 && value !== 1)) return null;
    const gate: QualityFailureGate = { status: row.status, knownRisks,
      ...(row.build_passed !== null ? { buildPassed: row.build_passed === 1 } : {}),
      ...(row.tests_passed !== null ? { testsPassed: row.tests_passed === 1 } : {}),
      ...(row.smoke_passed !== null ? { smokePassed: row.smoke_passed === 1 } : {}),
    };
    // The gate selects its own immutable execution proofs. Never substitute
    // today's latest checker result for an older gate's evidence.
    const proofs = this.db.prepare(`SELECT v.checker_id, v.kinds_json, v.exit_code,v.failure_fingerprint
      FROM validation_runs v
      WHERE v.task_run_id=? AND v.artifact_id IN (SELECT value FROM json_each(?))
        AND v.status IN ('completed','failed')
        AND (v.status='failed' OR v.exit_code<>0)`)
      .all(taskRunId, JSON.stringify(evidence)) as { checker_id: string; kinds_json: string; exit_code: number | null;failure_fingerprint:string|null }[];
    const checkers: FailedQualityChecker[] = [];
    for (const proof of proofs) {
      const kinds = strictStringArray(proof.kinds_json);
      if (!kinds || kinds.some(kind => !["build", "test", "smoke"].includes(kind)) ||
          !proof.checker_id || (proof.exit_code !== null && !Number.isSafeInteger(proof.exit_code))) return null;
      if(proof.failure_fingerprint!==null&&(!proof.checker_id.startsWith('regression:')||!/^[a-f0-9]{64}$/.test(proof.failure_fingerprint)))return null;
      if (kinds.length > 0) checkers.push({ checkerId: proof.checker_id, kinds, exitCode: proof.exit_code,...(proof.failure_fingerprint?{failureFingerprint:proof.failure_fingerprint}:{}) });
    }
    return { basis: qualityFailureSignature(gate), signature: qualityFailureSignature(gate, checkers),
      baseSignature:qualityFailureSignature(gate,checkers.map(({failureFingerprint,...c})=>c)),
      hasFailureDetails:checkers.length>0&&checkers.every(c=>!!c.failureFingerprint),hasCheckers: checkers.length > 0 };
  }

  private createSync(input: CreateRepairAttemptInput): RepairAttempt {
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
