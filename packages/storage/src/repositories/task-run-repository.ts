import type {
  CreateTaskRunInput,
  TaskRun,
  TaskRunStatus,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToTaskRun } from "./row-mappers.ts";

export interface TaskRunRepository {
  create(input: CreateTaskRunInput): Promise<TaskRun>;
  listByThread(threadId: string): Promise<TaskRun[]>;
  get(id: string): Promise<TaskRun | null>;
  updateStatus(id: string, status: TaskRunStatus): Promise<TaskRun>;
  setCurrentStep(id: string, stepId: string | null): Promise<TaskRun>;
  delete(id: string): Promise<void>;
}

export class SqliteTaskRunRepository implements TaskRunRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    const now = nowIso();
    const taskRun: TaskRun = {
      id: newId("taskRun"),
      threadId: input.threadId,
      userRequest: input.userRequest,
      targetDir: input.targetDir,
      status: input.status ?? "drafting",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO task_runs(id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at)
         VALUES(@id, @threadId, @userRequest, @targetDir, @status, NULL, @createdAt, @updatedAt)`,
      )
      .run({
        id: taskRun.id,
        threadId: taskRun.threadId,
        userRequest: taskRun.userRequest,
        targetDir: taskRun.targetDir,
        status: taskRun.status,
        createdAt: taskRun.createdAt,
        updatedAt: taskRun.updatedAt,
      });

    return taskRun;
  }

  async listByThread(threadId: string): Promise<TaskRun[]> {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at
         FROM task_runs WHERE thread_id = ?
         ORDER BY datetime(created_at) DESC, rowid DESC`,
      )
      .all(threadId) as Parameters<typeof rowToTaskRun>[0][];
    return rows.map(rowToTaskRun);
  }

  async get(id: string): Promise<TaskRun | null> {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, user_request, target_dir, status, current_step_id, created_at, updated_at
         FROM task_runs WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToTaskRun>[0] | undefined;
    return row ? rowToTaskRun(row) : null;
  }

  async updateStatus(id: string, status: TaskRunStatus): Promise<TaskRun> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`TaskRun ${id} not found`);
    const next: TaskRun = {
      ...existing,
      status,
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE task_runs SET status=@status, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({ id: next.id, status: next.status, updatedAt: next.updatedAt });
    return next;
  }

  async setCurrentStep(id: string, stepId: string | null): Promise<TaskRun> {
    const existing = await this.get(id);
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
