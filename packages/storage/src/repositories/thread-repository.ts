import type {
  CreateThreadInput,
  Thread,
  UpdateThreadInput,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToThread } from "./row-mappers.ts";

export interface ThreadRepository {
  create(input: CreateThreadInput): Promise<Thread>;
  list(): Promise<Thread[]>;
  get(id: string): Promise<Thread | null>;
  update(id: string, patch: UpdateThreadInput): Promise<Thread>;
  delete(id: string): Promise<void>;
}

export class SqliteThreadRepository implements ThreadRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateThreadInput): Promise<Thread> {
    const now = nowIso();
    const thread: Thread = {
      id: newId("thread"),
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };
    if (input.targetDir !== undefined) thread.targetDir = input.targetDir;

    this.db
      .prepare(
        `INSERT INTO threads(id, title, target_dir, created_at, updated_at, archived_at)
         VALUES(@id, @title, @targetDir, @createdAt, @updatedAt, NULL)`,
      )
      .run({
        id: thread.id,
        title: thread.title,
        targetDir: thread.targetDir ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });

    return thread;
  }

  async list(): Promise<Thread[]> {
    const rows = this.db
      .prepare(
        `SELECT id, title, target_dir, created_at, updated_at, archived_at, agent_session_id
         FROM threads ORDER BY datetime(updated_at) DESC, rowid DESC`,
      )
      .all() as Parameters<typeof rowToThread>[0][];
    return rows.map(rowToThread);
  }

  async get(id: string): Promise<Thread | null> {
    const row = this.db
      .prepare(
        `SELECT id, title, target_dir, created_at, updated_at, archived_at, agent_session_id
         FROM threads WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToThread>[0] | undefined;
    return row ? rowToThread(row) : null;
  }

  async delete(id: string): Promise<void> {
    this.db.transaction(() => {
      const sub = `(SELECT id FROM task_runs WHERE thread_id = ?)`;
      this.db.prepare(`DELETE FROM agent_invocations WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM quality_gate_results WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM learning_traces WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM approvals WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM checkpoints WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM artifacts WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM steps WHERE task_run_id IN ${sub}`).run(id);
      this.db.prepare(`DELETE FROM task_runs WHERE thread_id = ?`).run(id);
      this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    })();
  }

  async update(id: string, patch: UpdateThreadInput): Promise<Thread> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Thread ${id} not found`);
    }
    const next: Thread = { ...existing };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.targetDir !== undefined) next.targetDir = patch.targetDir;
    if (patch.archivedAt !== undefined) {
      if (patch.archivedAt === null) delete next.archivedAt;
      else next.archivedAt = patch.archivedAt;
    }
    if (patch.agentSessionId !== undefined) {
      if (patch.agentSessionId === null) delete next.agentSessionId;
      else next.agentSessionId = patch.agentSessionId;
    }
    next.updatedAt = nowIso();

    this.db
      .prepare(
        `UPDATE threads
         SET title=@title, target_dir=@targetDir, updated_at=@updatedAt, archived_at=@archivedAt, agent_session_id=@agentSessionId
         WHERE id=@id`,
      )
      .run({
        id: next.id,
        title: next.title,
        targetDir: next.targetDir ?? null,
        updatedAt: next.updatedAt,
        archivedAt: next.archivedAt ?? null,
        agentSessionId: next.agentSessionId ?? null,
      });

    return next;
  }
}
