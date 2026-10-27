import type { QualityGateResult, QualityGateStatus, QualityValidationState } from "@harness/core";
import type { HarnessDb } from "../db.ts";

export interface QualityGateRepository {
  create(result: QualityGateResult): Promise<QualityGateResult>;
  listByTaskRun(taskRunId: string): Promise<QualityGateResult[]>;
  getLatestForTaskRun(taskRunId: string): Promise<QualityGateResult | null>;
}

interface QualityGateRow {
  id: string;
  task_run_id: string;
  status: QualityGateStatus;
  build_passed: number | null;
  tests_passed: number | null;
  smoke_passed: number | null;
  changed_files_reviewed: number | null;
  known_risks_json: string;
  evidence_artifact_ids_json: string;
  created_at: string;
  validation_state_json: string | null;
}

const intToBool = (v: number | null): boolean | undefined => {
  if (v === null) return undefined;
  return v === 1;
};

const rowToQualityGate = (r: QualityGateRow): QualityGateResult => {
  let knownRisks: string[] = [];
  let evidenceArtifactIds: string[] = [];
  try {
    knownRisks = JSON.parse(r.known_risks_json) as string[];
  } catch {
    knownRisks = [];
  }
  try {
    evidenceArtifactIds = JSON.parse(r.evidence_artifact_ids_json) as string[];
  } catch {
    evidenceArtifactIds = [];
  }

  const result: QualityGateResult = {
    id: r.id,
    taskRunId: r.task_run_id,
    status: r.status,
    knownRisks,
    evidenceArtifactIds,
    createdAt: r.created_at,
  };
  const buildPassed = intToBool(r.build_passed);
  if (buildPassed !== undefined) result.buildPassed = buildPassed;
  const testsPassed = intToBool(r.tests_passed);
  if (testsPassed !== undefined) result.testsPassed = testsPassed;
  const smokePassed = intToBool(r.smoke_passed);
  if (smokePassed !== undefined) result.smokePassed = smokePassed;
  const changedFilesReviewed = intToBool(r.changed_files_reviewed);
  if (changedFilesReviewed !== undefined)
    result.changedFilesReviewed = changedFilesReviewed;
  if (r.validation_state_json !== null && r.validation_state_json !== undefined) {
    const value: unknown = JSON.parse(r.validation_state_json);
    if (!isValidationState(value)) throw new Error("Invalid quality validation state");
    result.validationState = value;
  }
  return result;
};

export class SqliteQualityGateRepository implements QualityGateRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(result: QualityGateResult): Promise<QualityGateResult> {
    return this.db.transaction(() => {
      let stored = result;
      const validation = result.validationState;
      if (validation !== undefined && !isValidationState(validation)) throw new TypeError("Invalid quality validation state");
      if (result.status === "passed" && validation && !this.isValidationCurrent(result.taskRunId, validation)) {
        const { buildPassed: _build, testsPassed: _tests, smokePassed: _smoke, ...rest } = result;
        stored = { ...rest, status: "warning", knownRisks: [...new Set([...result.knownRisks,
          "Workspace or validation results changed during quality evaluation; re-run quality checks"])] };
      }
      this.db
        .prepare(
          `INSERT INTO quality_gate_results
            (id, task_run_id, status, build_passed, tests_passed, smoke_passed,
             changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at, validation_state_json)
           VALUES(@id, @taskRunId, @status, @buildPassed, @testsPassed, @smokePassed,
                  @changedFilesReviewed, @knownRisksJson, @evidenceArtifactIdsJson, @createdAt, @validationStateJson)`,
        )
        .run({
          id: stored.id,
          taskRunId: stored.taskRunId,
          status: stored.status,
          buildPassed:
            stored.buildPassed === undefined ? null : stored.buildPassed ? 1 : 0,
          testsPassed:
            stored.testsPassed === undefined ? null : stored.testsPassed ? 1 : 0,
          smokePassed:
            stored.smokePassed === undefined ? null : stored.smokePassed ? 1 : 0,
          changedFilesReviewed:
            stored.changedFilesReviewed === undefined
              ? null
              : stored.changedFilesReviewed
                ? 1
                : 0,
          knownRisksJson: JSON.stringify(stored.knownRisks),
          evidenceArtifactIdsJson: JSON.stringify(stored.evidenceArtifactIds),
          createdAt: stored.createdAt,
          validationStateJson: stored.validationState === undefined ? null : JSON.stringify(stored.validationState),
        });
      return stored;
    }).immediate();
  }

  private isValidationCurrent(taskRunId: string, validation: QualityValidationState): boolean {
    if (validation.fingerprint === null) return false;
    const workspace = this.db.prepare("SELECT generation,active_mutations FROM workspace_validation_state WHERE workspace_key=?")
      .get(validation.workspaceKey) as { generation: number; active_mutations: number } | undefined;
    const ledger = this.db.prepare("SELECT COUNT(*) + COUNT(finished_at) AS watermark FROM validation_runs WHERE task_run_id=?")
      .get(taskRunId) as { watermark: number };
    return (workspace?.generation ?? 0) === validation.generation && (workspace?.active_mutations ?? 0) === 0 && ledger.watermark === validation.watermark;
  }

  async listByTaskRun(taskRunId: string): Promise<QualityGateResult[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, status, build_passed, tests_passed, smoke_passed,
                changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at, validation_state_json
         FROM quality_gate_results
         WHERE task_run_id = ?
         ORDER BY rowid ASC`,
      )
      .all(taskRunId) as QualityGateRow[];
    return rows.map(rowToQualityGate);
  }

  async getLatestForTaskRun(
    taskRunId: string,
  ): Promise<QualityGateResult | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, status, build_passed, tests_passed, smoke_passed,
                changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at, validation_state_json
         FROM quality_gate_results
         WHERE task_run_id = ?
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(taskRunId) as QualityGateRow | undefined;
    return row ? rowToQualityGate(row) : null;
  }
}

const isValidationState = (value: unknown): value is QualityValidationState => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.workspaceKey === "string" && v.workspaceKey.length > 0 &&
    (v.fingerprint === null || (typeof v.fingerprint === "string" && v.fingerprint.length > 0)) &&
    typeof v.generation === "number" && Number.isSafeInteger(v.generation) && v.generation >= 0 &&
    typeof v.watermark === "number" && Number.isSafeInteger(v.watermark) && v.watermark >= 0;
};
