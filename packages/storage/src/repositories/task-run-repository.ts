import type {
  CreateTaskRunInput,
  TaskRun,
  TaskRunStatus,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { buildTaskContract } from "@harness/core";
import { newId, nowIso } from "../id.ts";
import { rowToTaskRun } from "./row-mappers.ts";

export interface TaskRunRepository {
  create(input: CreateTaskRunInput): Promise<TaskRun>;
  listByThread(threadId: string): Promise<TaskRun[]>;
  get(id: string): Promise<TaskRun | null>;
  updateStatus(id: string, status: TaskRunStatus, expectedStatus?: TaskRunStatus): Promise<TaskRun>;
  setCurrentStep(id: string, stepId: string | null): Promise<TaskRun>;
  delete(id: string): Promise<void>;
}

export class SqliteTaskRunRepository implements TaskRunRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    return this.createSync(input);
  }

  createSync(input: CreateTaskRunInput): TaskRun {
    const now = nowIso();
    const taskRun: TaskRun = {
      id: newId("taskRun"),
      threadId: input.threadId,
      userRequest: input.userRequest,
      contract: buildTaskContract({
        userRequest: input.userRequest,
        ...(input.intent !== undefined ? { intent: input.intent } : {}),
      }),
      targetDir: input.targetDir,
      status: input.status ?? "drafting",
      createdAt: now,
      updatedAt: now,
    };
    if (input.followUpTaskRunId !== undefined) {
      taskRun.followUpTaskRunId = input.followUpTaskRunId;
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO task_runs(id, thread_id, user_request, target_dir, follow_up_task_run_id, status, current_step_id, created_at, updated_at)
         VALUES(@id, @threadId, @userRequest, @targetDir, @followUpTaskRunId, @status, NULL, @createdAt, @updatedAt)`,
        )
        .run({
          id: taskRun.id,
          threadId: taskRun.threadId,
          userRequest: taskRun.userRequest,
          targetDir: taskRun.targetDir,
          followUpTaskRunId: taskRun.followUpTaskRunId ?? null,
          status: taskRun.status,
          createdAt: taskRun.createdAt,
          updatedAt: taskRun.updatedAt,
        });
      this.db.prepare(
        `INSERT INTO task_contracts(task_run_id, revision, contract_json, created_at) VALUES (?, 1, ?, ?)`,
      ).run(taskRun.id, JSON.stringify(taskRun.contract), now);
    })();

    return taskRun;
  }

  async listByThread(threadId: string): Promise<TaskRun[]> {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, user_request, target_dir, follow_up_task_run_id, status, current_step_id, created_at, updated_at,
          (SELECT contract_json FROM task_contracts WHERE task_run_id = task_runs.id) AS contract_json
         FROM task_runs WHERE thread_id = ?
         ORDER BY datetime(created_at) DESC, rowid DESC`,
      )
      .all(threadId) as Parameters<typeof rowToTaskRun>[0][];
    return rows.map(rowToTaskRun);
  }

  async get(id: string): Promise<TaskRun | null> {
    return this.getSync(id);
  }

  getSync(id: string): TaskRun | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, user_request, target_dir, follow_up_task_run_id, status, current_step_id, created_at, updated_at,
          (SELECT contract_json FROM task_contracts WHERE task_run_id = task_runs.id) AS contract_json
         FROM task_runs WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToTaskRun>[0] | undefined;
    return row ? rowToTaskRun(row) : null;
  }

  async updateStatus(id: string, status: TaskRunStatus, expectedStatus?: TaskRunStatus): Promise<TaskRun> {
    const existing = await this.get(id);
    return this.updateExistingStatus(id, existing, status, expectedStatus);
  }

  updateStatusSync(id: string, status: TaskRunStatus, expectedStatus?: TaskRunStatus): TaskRun {
    return this.updateExistingStatus(id, this.getSync(id), status, expectedStatus);
  }

  private updateExistingStatus(
    id: string,
    existing: TaskRun | null,
    status: TaskRunStatus,
    expectedStatus?: TaskRunStatus,
  ): TaskRun {
    if (!existing) throw new Error(`TaskRun ${id} not found`);
    const next: TaskRun = {
      ...existing,
      status,
      updatedAt: nowIso(),
    };
    const updated = this.db
      .prepare(
        `UPDATE task_runs SET status=@status, updated_at=@updatedAt
         WHERE id=@id AND status=@expectedStatus`,
      )
      .run({ id: next.id, status: next.status, updatedAt: next.updatedAt,
        expectedStatus: expectedStatus ?? existing.status });
    if (updated.changes !== 1) {
      // Independent runners may publish the same state concurrently. Treat
      // that as idempotent without writing over a newer, different state.
      const current = this.getSync(id);
      if (current?.status === status) return current;
      throw Object.assign(new Error("작업 상태가 변경되었습니다. 최신 상태를 확인한 후 다시 시도하세요."), {
        code: "TASK_RUN_STATE_CONFLICT",
      });
    }
    return next;
  }

  async setCurrentStep(id: string, stepId: string | null): Promise<TaskRun> {
    const existing = await this.get(id);
    return this.setExistingCurrentStep(id, existing, stepId);
  }

  setCurrentStepSync(id: string, stepId: string | null): TaskRun {
    return this.setExistingCurrentStep(id, this.getSync(id), stepId);
  }

  private setExistingCurrentStep(id: string, existing: TaskRun | null, stepId: string | null): TaskRun {
    if (!existing) throw new Error(`TaskRun ${id} not found`);
    const next: TaskRun = { ...existing, updatedAt: nowIso() };
    if (stepId === null) delete next.currentStepId;
    else next.currentStepId = stepId;
    this.db
      .prepare(
        `UPDATE task_runs SET current_step_id=@currentStepId, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: next.id,
        currentStepId: stepId,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  async delete(id: string): Promise<void> {
    // Deletion order respects FK constraints with PRAGMA foreign_keys=ON.
    // agent_invocations must precede artifacts (prompt_artifact_id RESTRICT).
    // approvals must precede checkpoints; checkpoints/artifacts must precede steps.
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_invocations WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM observations WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM quality_gate_results WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM learning_traces WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM approvals WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM checkpoints WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM artifacts WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM steps WHERE task_run_id = ?`).run(id);
      this.db.prepare(`DELETE FROM task_runs WHERE id = ?`).run(id);
    })();
  }
}
