import type { QualityGateResult, QualityGateStatus } from "@harness/core";
import type { HarnessDb } from "../db";

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
  return result;
};

export class SqliteQualityGateRepository implements QualityGateRepository {
  constructor(private readonly db: HarnessDb) {}

  async create(result: QualityGateResult): Promise<QualityGateResult> {
    this.db
      .prepare(
        `INSERT INTO quality_gate_results
          (id, task_run_id, status, build_passed, tests_passed, smoke_passed,
           changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at)
         VALUES(@id, @taskRunId, @status, @buildPassed, @testsPassed, @smokePassed,
                @changedFilesReviewed, @knownRisksJson, @evidenceArtifactIdsJson, @createdAt)`,
      )
      .run({
        id: result.id,
        taskRunId: result.taskRunId,
        status: result.status,
        buildPassed:
          result.buildPassed === undefined ? null : result.buildPassed ? 1 : 0,
        testsPassed:
          result.testsPassed === undefined ? null : result.testsPassed ? 1 : 0,
        smokePassed:
          result.smokePassed === undefined ? null : result.smokePassed ? 1 : 0,
        changedFilesReviewed:
          result.changedFilesReviewed === undefined
            ? null
            : result.changedFilesReviewed
              ? 1
              : 0,
        knownRisksJson: JSON.stringify(result.knownRisks),
        evidenceArtifactIdsJson: JSON.stringify(result.evidenceArtifactIds),
        createdAt: result.createdAt,
      });
    return result;
  }

  async listByTaskRun(taskRunId: string): Promise<QualityGateResult[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, status, build_passed, tests_passed, smoke_passed,
                changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at
         FROM quality_gate_results
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, rowid ASC`,
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
                changed_files_reviewed, known_risks_json, evidence_artifact_ids_json, created_at
         FROM quality_gate_results
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) DESC, rowid DESC
         LIMIT 1`,
      )
      .get(taskRunId) as QualityGateRow | undefined;
    return row ? rowToQualityGate(row) : null;
  }
}
