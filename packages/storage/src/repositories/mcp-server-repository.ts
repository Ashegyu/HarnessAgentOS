import type { McpServerConfig, McpServerHealth } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

/**
 * MCP server registry — see docs/design/agent-detailed-settings.md §4.2.
 *
 * upsert() acts as create-or-update. When `server.id` is empty or missing
 * from the row set, the repository assigns a new id and stamps both
 * timestamps. Otherwise it updates in place and bumps `updated_at`.
 */
export interface McpServerRepository {
  list(): Promise<McpServerConfig[]>;
  get(id: string): Promise<McpServerConfig | null>;
  upsert(
    server: McpServerConfig | Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">,
  ): Promise<McpServerConfig>;
  delete(id: string): Promise<void>;
  toggle(id: string, enabled: boolean): Promise<McpServerConfig>;
  recordHealth(id: string, health: McpServerHealth): Promise<McpServerConfig>;
}

interface McpRow {
  id: string;
  name: string;
  description: string;
  transport: string;
  command: string | null;
  args_json: string | null;
  url: string | null;
  env_json: string;
  env_secret_refs_json: string;
  scope: string;
  enabled: number;
  last_health_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, description, transport, command, args_json, url,
       env_json, env_secret_refs_json, scope, enabled,
       last_health_json, created_at, updated_at
  FROM mcp_servers`;

const rowToServer = (row: McpRow): McpServerConfig => {
  const cfg: McpServerConfig = {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServerConfig["transport"],
    env: JSON.parse(row.env_json),
    envSecretRefs: JSON.parse(row.env_secret_refs_json),
    scope: row.scope as McpServerConfig["scope"],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.command !== null) cfg.command = row.command;
  if (row.args_json !== null) cfg.args = JSON.parse(row.args_json);
  if (row.url !== null) cfg.url = row.url;
  if (row.last_health_json !== null) {
    cfg.lastHealth = JSON.parse(row.last_health_json);
  }
  return cfg;
};

export class SqliteMcpServerRepository implements McpServerRepository {
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async list(): Promise<McpServerConfig[]> {
    const rows = this.db
      .prepare<[], McpRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToServer);
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const row = this.db
      .prepare<[string], McpRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToServer(row) : null;
  }

  async upsert(
    server:
      | McpServerConfig
      | Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">,
  ): Promise<McpServerConfig> {
    const incomingId = "id" in server ? server.id : "";
    const existingRow = incomingId
      ? this.db
          .prepare<[string], { id: string; created_at: string }>(
            `SELECT id, created_at FROM mcp_servers WHERE id = ?`,
          )
          .get(incomingId)
      : undefined;

    if (existingRow) {
      const now = nowIso();
      const next: McpServerConfig = {
        ...(server as McpServerConfig),
        id: existingRow.id,
        createdAt: existingRow.created_at,
        updatedAt: now,
      };
      this.writeRow(next, "update");
      return next;
    }

    // Create branch. `incomingId` may have been a stale UUID the caller
    // remembered; we honor an explicit id if present, otherwise mint one.
    const id = incomingId || newId("mcpServer");
    const now = nowIso();
    const next: McpServerConfig = {
      ...(server as McpServerConfig),
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRow(next, "insert");
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
  }

  async toggle(id: string, enabled: boolean): Promise<McpServerConfig> {
    this.db
      .prepare(
        `UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, nowIso(), id);
    const refreshed = await this.get(id);
    if (!refreshed) throw new Error(`McpServer not found: ${id}`);
    return refreshed;
  }

  async recordHealth(
    id: string,
    health: McpServerHealth,
  ): Promise<McpServerConfig> {
    this.db
      .prepare(
        `UPDATE mcp_servers SET last_health_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(health), nowIso(), id);
    const refreshed = await this.get(id);
    if (!refreshed) throw new Error(`McpServer not found: ${id}`);
    return refreshed;
  }

  private writeRow(s: McpServerConfig, mode: "insert" | "update"): void {
    const command = s.command ?? null;
    const args = s.args ? JSON.stringify(s.args) : null;
    const url = s.url ?? null;
    const lastHealth = s.lastHealth ? JSON.stringify(s.lastHealth) : null;

    if (mode === "insert") {
      this.db
        .prepare(
          `INSERT INTO mcp_servers
            (id, name, description, transport, command, args_json, url,
             env_json, env_secret_refs_json, scope, enabled,
             last_health_json, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          s.id,
          s.name,
          s.description,
          s.transport,
          command,
          args,
          url,
          JSON.stringify(s.env),
          JSON.stringify(s.envSecretRefs),
          s.scope,
          s.enabled ? 1 : 0,
          lastHealth,
          s.createdAt,
          s.updatedAt,
        );
    } else {
      this.db
        .prepare(
          `UPDATE mcp_servers SET
             name = ?, description = ?, transport = ?, command = ?,
             args_json = ?, url = ?, env_json = ?, env_secret_refs_json = ?,
             scope = ?, enabled = ?, last_health_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          s.name,
          s.description,
          s.transport,
          command,
          args,
          url,
          JSON.stringify(s.env),
          JSON.stringify(s.envSecretRefs),
          s.scope,
          s.enabled ? 1 : 0,
          lastHealth,
          s.updatedAt,
          s.id,
        );
    }
  }
}
