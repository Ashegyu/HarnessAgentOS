import type { SkillSource } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

/**
 * Skill source registry — see docs/design/agent-detailed-settings.md §4.3.
 *
 * Custom rows (user-registered directories) start with trusted=false so
 * `skill_script` approvals must be promoted explicitly. The project/user
 * sentinel rows are seeded by `ensureSeed()` and carry trusted=true.
 */
export interface SkillSourceRepository {
  list(): Promise<SkillSource[]>;
  get(id: string): Promise<SkillSource | null>;
  add(input: { name: string; rootDir: string }): Promise<SkillSource>;
  update(source: SkillSource): Promise<SkillSource>;
  remove(id: string): Promise<void>;
  ensureSeed(input: {
    projectRootDir: string;
    userRootDir: string;
  }): Promise<void>;
}

interface SsRow {
  id: string;
  name: string;
  origin: string;
  root_dir: string;
  trusted: number;
  enabled: number;
  registered_in_path_policy: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, origin, root_dir, trusted, enabled,
       registered_in_path_policy, created_at, updated_at
  FROM skill_sources`;

const rowToSource = (row: SsRow): SkillSource => ({
  id: row.id,
  name: row.name,
  origin: row.origin as SkillSource["origin"],
  rootDir: row.root_dir,
  trusted: row.trusted === 1,
  enabled: row.enabled === 1,
  registeredInPathPolicy: row.registered_in_path_policy === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteSkillSourceRepository implements SkillSourceRepository {
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<SkillSource[]> {
    const rows = this.db
      .prepare<[], SsRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToSource);
  }

  async get(id: string): Promise<SkillSource | null> {
    const row = this.db
      .prepare<[string], SsRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToSource(row) : null;
  }

  async add(input: { name: string; rootDir: string }): Promise<SkillSource> {
    const id = newId("skillSource");
    const now = nowIso();
    const source: SkillSource = {
      id,
      name: input.name,
      origin: "custom",
      rootDir: input.rootDir,
      trusted: false,
      enabled: true,
      registeredInPathPolicy: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.insertRow(source);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE") || msg.includes("constraint")) {
        throw new Error(
          `Skill source already registered for rootDir: ${input.rootDir}`,
        );
      }
      throw e;
    }
    return source;
  }

  async update(source: SkillSource): Promise<SkillSource> {
    const updated: SkillSource = { ...source, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE skill_sources SET
           name = ?, origin = ?, root_dir = ?, trusted = ?, enabled = ?,
           registered_in_path_policy = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.origin,
        updated.rootDir,
        updated.trusted ? 1 : 0,
        updated.enabled ? 1 : 0,
        updated.registeredInPathPolicy ? 1 : 0,
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM skill_sources WHERE id = ?`).run(id);
  }

  /**
   * Insert sentinel rows for the built-in project/user skill directories
   * if they don't yet exist. Idempotent: pre-existing rows are left
   * untouched (so user edits like a renamed sentinel survive).
   */
  async ensureSeed(input: {
    projectRootDir: string;
    userRootDir: string;
  }): Promise<void> {
    const now = nowIso();
    const upsertSentinel = this.db.prepare(
      `INSERT INTO skill_sources
        (id, name, origin, root_dir, trusted, enabled,
         registered_in_path_policy, created_at, updated_at)
       VALUES (?,?,?,?,1,1,1,?,?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const txn = this.db.transaction(() => {
      upsertSentinel.run(
        "ss_project",
        "Project skills",
        "project",
        input.projectRootDir,
        now,
        now,
      );
      upsertSentinel.run(
        "ss_user",
        "User skills",
        "user",
        input.userRootDir,
        now,
        now,
      );
    });
    txn();
  }

  private insertRow(s: SkillSource): void {
    this.db
      .prepare(
        `INSERT INTO skill_sources
          (id, name, origin, root_dir, trusted, enabled,
           registered_in_path_policy, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.name,
        s.origin,
        s.rootDir,
        s.trusted ? 1 : 0,
        s.enabled ? 1 : 0,
        s.registeredInPathPolicy ? 1 : 0,
        s.createdAt,
        s.updatedAt,
      );
  }
}
