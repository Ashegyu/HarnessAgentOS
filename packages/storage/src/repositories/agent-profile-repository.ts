import type {
  AgentProfile,
  AgentPermissions,
  AgentCliEnv,
  AgentModelTuning,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

/**
 * CRUD for AgentProfile rows — see docs/design/agent-detailed-settings.md §4.1.
 *
 * Nested objects (tuning/cli/permissions/mcpServerIds/skillSourceIds) are
 * stored as JSON columns. The repository serializes on the way in and
 * parses on the way out; callers see plain JS objects.
 */
export type CreateAgentProfileInput = Omit<
  AgentProfile,
  "id" | "createdAt" | "updatedAt"
>;

export interface AgentProfileRepository {
  list(): Promise<AgentProfile[]>;
  get(id: string): Promise<AgentProfile | null>;
  create(input: CreateAgentProfileInput): Promise<AgentProfile>;
  update(profile: AgentProfile): Promise<AgentProfile>;
  delete(id: string): Promise<void>;
  setDefault(id: string): Promise<AgentProfile>;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  role: string;
  persona: string;
  tuning_json: string;
  cli_json: string;
  permissions_json: string;
  mcp_server_ids_json: string;
  skill_source_ids_json: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const rowToProfile = (row: ProfileRow): AgentProfile => ({
  id: row.id,
  name: row.name,
  description: row.description,
  provider: row.provider as AgentProfile["provider"],
  role: row.role as AgentProfile["role"],
  persona: row.persona,
  tuning: JSON.parse(row.tuning_json) as AgentModelTuning,
  cli: JSON.parse(row.cli_json) as AgentCliEnv,
  permissions: JSON.parse(row.permissions_json) as AgentPermissions,
  mcpServerIds: JSON.parse(row.mcp_server_ids_json) as string[],
  skillSourceIds: JSON.parse(row.skill_source_ids_json) as string[],
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `SELECT id, name, description, provider, role, persona,
       tuning_json, cli_json, permissions_json,
       mcp_server_ids_json, skill_source_ids_json,
       is_default, created_at, updated_at
  FROM agent_profiles`;

export class SqliteAgentProfileRepository implements AgentProfileRepository {
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<AgentProfile[]> {
    const rows = this.db
      .prepare<[], ProfileRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToProfile);
  }

  async get(id: string): Promise<AgentProfile | null> {
    const row = this.db
      .prepare<[string], ProfileRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToProfile(row) : null;
  }

  async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    const id = newId("agentProfile");
    const now = nowIso();
    const profile: AgentProfile = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.insertRow(profile);
    return profile;
  }

  async update(profile: AgentProfile): Promise<AgentProfile> {
    const updated: AgentProfile = { ...profile, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE agent_profiles SET
           name = ?, description = ?, provider = ?, role = ?, persona = ?,
           tuning_json = ?, cli_json = ?, permissions_json = ?,
           mcp_server_ids_json = ?, skill_source_ids_json = ?,
           is_default = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        updated.provider,
        updated.role,
        updated.persona,
        JSON.stringify(updated.tuning),
        JSON.stringify(updated.cli),
        JSON.stringify(updated.permissions),
        JSON.stringify(updated.mcpServerIds),
        JSON.stringify(updated.skillSourceIds),
        updated.isDefault ? 1 : 0,
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agent_profiles WHERE id = ?`).run(id);
  }

  /**
   * Atomic promotion. The partial unique index on is_default=1 means we
   * must demote the prior default before flipping the new one within the
   * same transaction; otherwise the unique constraint fires mid-update.
   */
  async setDefault(id: string): Promise<AgentProfile> {
    const txn = this.db.transaction((targetId: string) => {
      this.db.prepare(`UPDATE agent_profiles SET is_default = 0`).run();
      this.db
        .prepare(
          `UPDATE agent_profiles SET is_default = 1, updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), targetId);
    });
    txn(id);
    const refreshed = await this.get(id);
    if (!refreshed) {
      throw new Error(`AgentProfile not found after setDefault: ${id}`);
    }
    return refreshed;
  }

  private insertRow(p: AgentProfile): void {
    this.db
      .prepare(
        `INSERT INTO agent_profiles
          (id, name, description, provider, role, persona,
           tuning_json, cli_json, permissions_json,
           mcp_server_ids_json, skill_source_ids_json,
           is_default, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        p.name,
        p.description,
        p.provider,
        p.role,
        p.persona,
        JSON.stringify(p.tuning),
        JSON.stringify(p.cli),
        JSON.stringify(p.permissions),
        JSON.stringify(p.mcpServerIds),
        JSON.stringify(p.skillSourceIds),
        p.isDefault ? 1 : 0,
        p.createdAt,
        p.updatedAt,
      );
  }
}
