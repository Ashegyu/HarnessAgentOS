import type {
  A2ARefinementAttempt,
  A2ARefinementFeedbackSourceKind,
  A2ARefinementStatus,
  A2ARefinementStopReason,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface CreateA2ARefinementAttemptInput {
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: A2ARefinementFeedbackSourceKind;
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  referenceTaskIds: readonly string[];
  referenceArtifactIds: readonly string[];
  feedbackSignature: string;
  status?: A2ARefinementStatus;
  stopReason?: A2ARefinementStopReason;
}

export interface UpdateA2ARefinementAttemptPatch {
  status?: A2ARefinementStatus;
  stopReason?: A2ARefinementStopReason | null;
  remoteTaskId?: string | null;
  remoteContextId?: string | null;
  completedAt?: string | null;
}

export interface A2ARefinementAttemptRepository {
  create(
    input: CreateA2ARefinementAttemptInput,
  ): Promise<A2ARefinementAttempt>;
  update(
    id: string,
    patch: UpdateA2ARefinementAttemptPatch,
  ): Promise<A2ARefinementAttempt>;
  get(id: string): Promise<A2ARefinementAttempt | null>;
  listByTaskRun(taskRunId: string): Promise<A2ARefinementAttempt[]>;
  listByTargetInvocation(
    targetInvocationId: string,
  ): Promise<A2ARefinementAttempt[]>;
}

interface A2ARefinementAttemptRow {
  id: string;
  task_run_id: string;
  target_invocation_id: string;
  endpoint_id: string;
  feedback_source_kind: A2ARefinementFeedbackSourceKind;
  feedback_source_step_id: string | null;
  feedback_source_invocation_id: string | null;
  feedback_artifact_id: string | null;
  quality_gate_id: string | null;
  parent_remote_task_id: string | null;
  parent_remote_context_id: string | null;
  remote_task_id: string | null;
  remote_context_id: string | null;
  reference_task_ids_json: string;
  reference_artifact_ids_json: string;
  feedback_signature: string;
  attempt_index: number;
  status: A2ARefinementStatus;
  stop_reason: A2ARefinementStopReason | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const parseStringArray = (raw: string): string[] => {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("A2A refinement JSON column is not an array");
  }
  if (!parsed.every((item) => typeof item === "string")) {
    throw new Error("A2A refinement JSON column contains non-string values");
  }
  return parsed;
};

const rowToAttempt = (
  row: A2ARefinementAttemptRow,
): A2ARefinementAttempt => {
  const attempt: A2ARefinementAttempt = {
    id: row.id,
    taskRunId: row.task_run_id,
    targetInvocationId: row.target_invocation_id,
    endpointId: row.endpoint_id,
    feedbackSourceKind: row.feedback_source_kind,
    referenceTaskIds: parseStringArray(row.reference_task_ids_json),
    referenceArtifactIds: parseStringArray(row.reference_artifact_ids_json),
    feedbackSignature: row.feedback_signature,
    attemptIndex: row.attempt_index,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.feedback_source_step_id !== null) {
    attempt.feedbackSourceStepId = row.feedback_source_step_id;
  }
  if (row.feedback_source_invocation_id !== null) {
    attempt.feedbackSourceInvocationId = row.feedback_source_invocation_id;
  }
  if (row.feedback_artifact_id !== null) {
    attempt.feedbackArtifactId = row.feedback_artifact_id;
  }
  if (row.quality_gate_id !== null) attempt.qualityGateId = row.quality_gate_id;
  if (row.parent_remote_task_id !== null) {
    attempt.parentRemoteTaskId = row.parent_remote_task_id;
  }
  if (row.parent_remote_context_id !== null) {
    attempt.parentRemoteContextId = row.parent_remote_context_id;
  }
  if (row.remote_task_id !== null) attempt.remoteTaskId = row.remote_task_id;
  if (row.remote_context_id !== null) {
    attempt.remoteContextId = row.remote_context_id;
  }
  if (row.stop_reason !== null) attempt.stopReason = row.stop_reason;
  if (row.completed_at !== null) attempt.completedAt = row.completed_at;
  return attempt;
};

export class SqliteA2ARefinementAttemptRepository
  implements A2ARefinementAttemptRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(
    input: CreateA2ARefinementAttemptInput,
  ): Promise<A2ARefinementAttempt> {
    const createInTransaction = this.db.transaction(() => {
      const now = nowIso();
      const attempt: A2ARefinementAttempt = {
        id: newId("a2aRefinement"),
        taskRunId: input.taskRunId,
        targetInvocationId: input.targetInvocationId,
        endpointId: input.endpointId,
        feedbackSourceKind: input.feedbackSourceKind,
        referenceTaskIds: [...input.referenceTaskIds],
        referenceArtifactIds: [...input.referenceArtifactIds],
        feedbackSignature: input.feedbackSignature,
        attemptIndex: this.nextAttemptIndex(
          input.taskRunId,
          input.targetInvocationId,
        ),
        status: input.status ?? "pending_approval",
        createdAt: now,
        updatedAt: now,
      };
      if (input.feedbackSourceStepId !== undefined) {
        attempt.feedbackSourceStepId = input.feedbackSourceStepId;
      }
      if (input.feedbackSourceInvocationId !== undefined) {
        attempt.feedbackSourceInvocationId = input.feedbackSourceInvocationId;
      }
      if (input.feedbackArtifactId !== undefined) {
        attempt.feedbackArtifactId = input.feedbackArtifactId;
      }
      if (input.qualityGateId !== undefined) {
        attempt.qualityGateId = input.qualityGateId;
      }
      if (input.parentRemoteTaskId !== undefined) {
        attempt.parentRemoteTaskId = input.parentRemoteTaskId;
      }
      if (input.parentRemoteContextId !== undefined) {
        attempt.parentRemoteContextId = input.parentRemoteContextId;
      }
      if (input.remoteTaskId !== undefined) {
        attempt.remoteTaskId = input.remoteTaskId;
      }
      if (input.remoteContextId !== undefined) {
        attempt.remoteContextId = input.remoteContextId;
      }
      if (input.stopReason !== undefined) attempt.stopReason = input.stopReason;

      this.insertAttempt(attempt);
      return attempt;
    });

    try {
      return createInTransaction();
    } catch (error) {
      if (
        error instanceof Error &&
        /idx_a2a_refinement_attempts_active_signature|UNIQUE constraint failed/i.test(
          error.message,
        )
      ) {
        throw new Error(
          "An active A2A refinement already exists for this feedback signature",
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    patch: UpdateA2ARefinementAttemptPatch,
  ): Promise<A2ARefinementAttempt> {
    const current = await this.get(id);
    if (!current) throw new Error(`A2ARefinementAttempt ${id} not found`);
    const next: A2ARefinementAttempt = {
      ...current,
      updatedAt: nowIso(),
    };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.stopReason !== undefined) {
      if (patch.stopReason === null) delete next.stopReason;
      else next.stopReason = patch.stopReason;
    }
    if (patch.remoteTaskId !== undefined) {
      if (patch.remoteTaskId === null) delete next.remoteTaskId;
      else next.remoteTaskId = patch.remoteTaskId;
    }
    if (patch.remoteContextId !== undefined) {
      if (patch.remoteContextId === null) delete next.remoteContextId;
      else next.remoteContextId = patch.remoteContextId;
    }
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) delete next.completedAt;
      else next.completedAt = patch.completedAt;
    }
    this.db
      .prepare(
        `UPDATE a2a_refinement_attempts SET
           status = @status,
           stop_reason = @stopReason,
           remote_task_id = @remoteTaskId,
           remote_context_id = @remoteContextId,
           updated_at = @updatedAt,
           completed_at = @completedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        status: next.status,
        stopReason: next.stopReason ?? null,
        remoteTaskId: next.remoteTaskId ?? null,
        remoteContextId: next.remoteContextId ?? null,
        updatedAt: next.updatedAt,
        completedAt: next.completedAt ?? null,
      });
    return next;
  }

  async get(id: string): Promise<A2ARefinementAttempt | null> {
    const row = this.db
      .prepare(`SELECT * FROM a2a_refinement_attempts WHERE id = ?`)
      .get(id) as A2ARefinementAttemptRow | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async listByTaskRun(taskRunId: string): Promise<A2ARefinementAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM a2a_refinement_attempts
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, id ASC`,
      )
      .all(taskRunId) as A2ARefinementAttemptRow[];
    return rows.map(rowToAttempt);
  }

  async listByTargetInvocation(
    targetInvocationId: string,
  ): Promise<A2ARefinementAttempt[]> {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM a2a_refinement_attempts
         WHERE target_invocation_id = ?
         ORDER BY attempt_index ASC, id ASC`,
      )
      .all(targetInvocationId) as A2ARefinementAttemptRow[];
    return rows.map(rowToAttempt);
  }

  private nextAttemptIndex(
    taskRunId: string,
    targetInvocationId: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_index), -1) + 1 AS nextIndex
         FROM a2a_refinement_attempts
         WHERE task_run_id = ? AND target_invocation_id = ?`,
      )
      .get(taskRunId, targetInvocationId) as { nextIndex: number };
    return row.nextIndex;
  }

  private insertAttempt(attempt: A2ARefinementAttempt): void {
    this.db
      .prepare(
        `INSERT INTO a2a_refinement_attempts(
           id, task_run_id, target_invocation_id, endpoint_id,
           feedback_source_kind, feedback_source_step_id,
           feedback_source_invocation_id, feedback_artifact_id, quality_gate_id,
           parent_remote_task_id, parent_remote_context_id, remote_task_id,
           remote_context_id, reference_task_ids_json,
           reference_artifact_ids_json, feedback_signature, attempt_index,
           status, stop_reason, created_at, updated_at, completed_at
         ) VALUES(
           @id, @taskRunId, @targetInvocationId, @endpointId,
           @feedbackSourceKind, @feedbackSourceStepId,
           @feedbackSourceInvocationId, @feedbackArtifactId, @qualityGateId,
           @parentRemoteTaskId, @parentRemoteContextId, @remoteTaskId,
           @remoteContextId, @referenceTaskIdsJson,
           @referenceArtifactIdsJson, @feedbackSignature, @attemptIndex,
           @status, @stopReason, @createdAt, @updatedAt, @completedAt
         )`,
      )
      .run({
        id: attempt.id,
        taskRunId: attempt.taskRunId,
        targetInvocationId: attempt.targetInvocationId,
        endpointId: attempt.endpointId,
        feedbackSourceKind: attempt.feedbackSourceKind,
        feedbackSourceStepId: attempt.feedbackSourceStepId ?? null,
        feedbackSourceInvocationId:
          attempt.feedbackSourceInvocationId ?? null,
        feedbackArtifactId: attempt.feedbackArtifactId ?? null,
        qualityGateId: attempt.qualityGateId ?? null,
        parentRemoteTaskId: attempt.parentRemoteTaskId ?? null,
        parentRemoteContextId: attempt.parentRemoteContextId ?? null,
        remoteTaskId: attempt.remoteTaskId ?? null,
        remoteContextId: attempt.remoteContextId ?? null,
        referenceTaskIdsJson: JSON.stringify(attempt.referenceTaskIds),
        referenceArtifactIdsJson: JSON.stringify(attempt.referenceArtifactIds),
        feedbackSignature: attempt.feedbackSignature,
        attemptIndex: attempt.attemptIndex,
        status: attempt.status,
        stopReason: attempt.stopReason ?? null,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
        completedAt: attempt.completedAt ?? null,
      });
  }
}
