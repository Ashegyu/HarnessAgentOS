import { randomUUID } from "node:crypto";
import type { BeginValidationRunInput, FinishValidationRunInput, ValidationKind, ValidationRun, ValidationRunStatus } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { nowIso } from "../id.ts";

export interface ValidationRunRepository {
  begin(input: BeginValidationRunInput): Promise<ValidationRun>;
  finish(id: string, input: FinishValidationRunInput): Promise<ValidationRun>;
  listByTaskRun(taskRunId: string): Promise<ValidationRun[]>;
  getWatermark(taskRunId: string): Promise<number>;
}

interface Row {
  id: string; sequence: number; task_run_id: string; step_id: string; approval_id: string;
  workspace_key: string; checker_id: string; kinds_json: string;
  start_fingerprint: string | null; start_generation: number;
  finish_fingerprint: string | null; finish_generation: number | null;
  status: ValidationRunStatus; exit_code: number | null; artifact_id: string | null;
  reason: string | null; started_at: string; finished_at: string | null;
}

const fromRow = (row: Row): ValidationRun => ({
  id: row.id, sequence: row.sequence, taskRunId: row.task_run_id, stepId: row.step_id,
  approvalId: row.approval_id, workspaceKey: row.workspace_key, checkerId: row.checker_id,
  kinds: JSON.parse(row.kinds_json) as ValidationKind[], startFingerprint: row.start_fingerprint,
  startGeneration: row.start_generation, status: row.status, startedAt: row.started_at,
  ...(row.finished_at !== null ? { finishedAt: row.finished_at, finishFingerprint: row.finish_fingerprint } : {}),
  ...(row.finish_generation !== null ? { finishGeneration: row.finish_generation } : {}),
  ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
  ...(row.artifact_id !== null ? { artifactId: row.artifact_id } : {}),
  ...(row.reason !== null ? { reason: row.reason } : {}),
});

const requireGeneration = (generation: number): void => {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("Invalid workspace generation");
};

export class SqliteValidationRunRepository implements ValidationRunRepository {
  constructor(private readonly db: HarnessDb) {}

  async begin(input: BeginValidationRunInput): Promise<ValidationRun> {
    requireGeneration(input.startGeneration);
    if (!input.workspaceKey || !input.checkerId || input.kinds.some(kind => !["build", "test", "smoke"].includes(kind))) {
      throw new TypeError("Invalid validation identity");
    }
    return this.db.transaction(() => {
      const linked = this.db.prepare(`SELECT 1 FROM approvals a
        JOIN steps s ON s.id = @stepId AND s.task_run_id = a.task_run_id
        JOIN task_runs t ON t.id = a.task_run_id
        WHERE a.id = @approvalId AND a.task_run_id = @taskRunId
          AND a.action_type = 'shell' AND a.execution_state = 'running'
          AND a.status IN ('approved','always_approved_for_run')
          AND a.approved_revision = a.action_revision AND a.approved_action_json = a.proposed_action_json
          AND s.status = 'running' AND s.kind IN ('shell','test') AND t.status NOT IN ('done','cancelled')`)
        .get({ stepId: input.stepId, approvalId: input.approvalId, taskRunId: input.taskRunId });
      if (!linked) throw new Error("Validation provenance requires a linked running approved execution");
      const id = `validation_${randomUUID()}`;
      this.db.prepare(`INSERT INTO validation_runs
        (id, task_run_id, step_id, approval_id, workspace_key, checker_id, kinds_json,
         start_fingerprint, start_generation, status, started_at, reason)
        VALUES (@id, @taskRunId, @stepId, @approvalId, @workspaceKey, @checkerId, @kindsJson,
         @startFingerprint, @startGeneration, 'running', @startedAt, @reason)`)
        .run({ ...input, id, kindsJson: JSON.stringify([...new Set(input.kinds)]), startedAt: nowIso(), reason: input.reason ?? null });
      return this.getSync(id)!;
    }).immediate();
  }

  async finish(id: string, input: FinishValidationRunInput): Promise<ValidationRun> {
    requireGeneration(input.finishGeneration);
    if (!["completed", "failed", "cancelled"].includes(input.status) ||
        (input.exitCode !== undefined && !Number.isSafeInteger(input.exitCode)) ||
        (input.status === "completed" && input.exitCode === undefined)) throw new TypeError("Invalid validation terminal result");
    return this.db.transaction(() => {
      const current = this.getSync(id);
      if (!current) throw new Error(`Validation run ${id} not found`);
      if (current.status !== "running") throw new Error("Validation run is already terminal");
      if (input.artifactId !== undefined) {
        const linked = this.db.prepare(`SELECT 1 FROM artifacts
          WHERE id=? AND task_run_id=? AND step_id=? AND kind IN ('log','test_result')`)
          .get(input.artifactId, current.taskRunId, current.stepId);
        if (!linked) throw new Error("Validation artifact provenance does not match its execution");
      } else if (input.status === "completed" && input.exitCode === 0) {
        throw new Error("Successful validation requires a linked result artifact");
      }
      const update = this.db.prepare(`UPDATE validation_runs SET status=@status,
        exit_code=@exitCode, artifact_id=@artifactId, finish_fingerprint=@finishFingerprint,
        finish_generation=@finishGeneration, reason=@reason, finished_at=@finishedAt
        WHERE id=@id AND status='running'`)
        .run({ id, status: input.status, exitCode: input.exitCode ?? null, artifactId: input.artifactId ?? null,
          finishFingerprint: input.finishFingerprint, finishGeneration: input.finishGeneration,
          reason: input.reason ?? current.reason ?? null, finishedAt: nowIso() });
      if (update.changes !== 1) throw new Error("Validation run is already terminal");
      return this.getSync(id)!;
    }).immediate();
  }

  async listByTaskRun(taskRunId: string): Promise<ValidationRun[]> {
    return (this.db.prepare("SELECT * FROM validation_runs WHERE task_run_id=? ORDER BY sequence ASC")
      .all(taskRunId) as Row[]).map(fromRow);
  }

  async getWatermark(taskRunId: string): Promise<number> { return this.getWatermarkSync(taskRunId); }

  getWatermarkSync(taskRunId: string): number {
    return (this.db.prepare("SELECT COUNT(*) + COUNT(finished_at) AS watermark FROM validation_runs WHERE task_run_id=?")
      .get(taskRunId) as { watermark: number }).watermark;
  }

  private getSync(id: string): ValidationRun | null {
    const row = this.db.prepare("SELECT * FROM validation_runs WHERE id=?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }
}
