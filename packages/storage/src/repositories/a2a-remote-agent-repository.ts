import type { A2AAgentCardSnapshot, A2AEndpoint } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export type CreateA2AEndpointInput = Omit<
  A2AEndpoint,
  "id" | "createdAt" | "updatedAt"
>;

export interface A2ARemoteAgentRepository {
  listEndpoints(): Promise<A2AEndpoint[]>;
  getEndpoint(id: string): Promise<A2AEndpoint | null>;
  upsertEndpoint(
    endpoint: A2AEndpoint | CreateA2AEndpointInput,
  ): Promise<A2AEndpoint>;
  deleteEndpoint(id: string): Promise<void>;
  toggleEndpoint(id: string, enabled: boolean): Promise<A2AEndpoint>;
  getCardSnapshot(endpointId: string): Promise<A2AAgentCardSnapshot | null>;
  upsertCardSnapshot(
    snapshot: A2AAgentCardSnapshot,
  ): Promise<A2AAgentCardSnapshot>;
}

interface EndpointRow {
  id: string;
  name: string;
  base_url: string;
  agent_card_url: string;
  preferred_transport: string;
  enabled: number;
  trusted: number;
  auth_secret_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface CardRow {
  endpoint_id: string;
  protocol_version: string | null;
  agent_name: string;
  description: string | null;
  version: string | null;
  skills_json: string;
  input_modes_json: string;
  output_modes_json: string;
  capabilities_json: string;
  fetched_at: string;
  etag: string | null;
  raw_card_json: string;
}

const ENDPOINT_SELECT = `SELECT id, name, base_url, agent_card_url,
       preferred_transport, enabled, trusted, auth_secret_ref,
       created_at, updated_at
  FROM a2a_endpoints`;

const CARD_SELECT = `SELECT endpoint_id, protocol_version, agent_name,
       description, version, skills_json, input_modes_json, output_modes_json,
       capabilities_json, fetched_at, etag, raw_card_json
  FROM a2a_agent_card_snapshots`;

const rowToEndpoint = (row: EndpointRow): A2AEndpoint => {
  const endpoint: A2AEndpoint = {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    agentCardUrl: row.agent_card_url,
    preferredTransport: row.preferred_transport as A2AEndpoint["preferredTransport"],
    enabled: row.enabled === 1,
    trusted: row.trusted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.auth_secret_ref !== null) endpoint.authSecretRef = row.auth_secret_ref;
  return endpoint;
};

const rowToCard = (row: CardRow): A2AAgentCardSnapshot => {
  const snapshot: A2AAgentCardSnapshot = {
    endpointId: row.endpoint_id,
    agentName: row.agent_name,
    skills: JSON.parse(row.skills_json),
    inputModes: JSON.parse(row.input_modes_json),
    outputModes: JSON.parse(row.output_modes_json),
    capabilities: JSON.parse(row.capabilities_json),
    fetchedAt: row.fetched_at,
    rawCardJson: row.raw_card_json,
  };
  if (row.protocol_version !== null) snapshot.protocolVersion = row.protocol_version;
  if (row.description !== null) snapshot.description = row.description;
  if (row.version !== null) snapshot.version = row.version;
  if (row.etag !== null) snapshot.etag = row.etag;
  return snapshot;
};

export class SqliteA2ARemoteAgentRepository
  implements A2ARemoteAgentRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async listEndpoints(): Promise<A2AEndpoint[]> {
    const rows = this.db
      .prepare<[], EndpointRow>(`${ENDPOINT_SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToEndpoint);
  }

  async getEndpoint(id: string): Promise<A2AEndpoint | null> {
    const row = this.db
      .prepare<[string], EndpointRow>(`${ENDPOINT_SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToEndpoint(row) : null;
  }

  async upsertEndpoint(
    endpoint: A2AEndpoint | CreateA2AEndpointInput,
  ): Promise<A2AEndpoint> {
    const incomingId = "id" in endpoint ? endpoint.id : "";
    const existingRow = incomingId
      ? this.db
          .prepare<[string], { id: string; created_at: string }>(
            `SELECT id, created_at FROM a2a_endpoints WHERE id = ?`,
          )
          .get(incomingId)
      : undefined;

    if (existingRow) {
      const next: A2AEndpoint = {
        ...(endpoint as A2AEndpoint),
        id: existingRow.id,
        createdAt: existingRow.created_at,
        updatedAt: nowIso(),
      };
      this.writeEndpoint(next, "update");
      return next;
    }

    const now = nowIso();
    const next: A2AEndpoint = {
      ...(endpoint as A2AEndpoint),
      id: incomingId || newId("a2aEndpoint"),
      createdAt: now,
      updatedAt: now,
    };
    this.writeEndpoint(next, "insert");
    return next;
  }

  async deleteEndpoint(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM a2a_endpoints WHERE id = ?`).run(id);
  }

  async toggleEndpoint(id: string, enabled: boolean): Promise<A2AEndpoint> {
    this.db
      .prepare(
        `UPDATE a2a_endpoints SET enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, nowIso(), id);
    const refreshed = await this.getEndpoint(id);
    if (!refreshed) throw new Error(`A2A endpoint not found: ${id}`);
    return refreshed;
  }

  async getCardSnapshot(
    endpointId: string,
  ): Promise<A2AAgentCardSnapshot | null> {
    const row = this.db
      .prepare<[string], CardRow>(`${CARD_SELECT} WHERE endpoint_id = ?`)
      .get(endpointId);
    return row ? rowToCard(row) : null;
  }

  async upsertCardSnapshot(
    snapshot: A2AAgentCardSnapshot,
  ): Promise<A2AAgentCardSnapshot> {
    this.db
      .prepare(
        `INSERT INTO a2a_agent_card_snapshots
          (endpoint_id, protocol_version, agent_name, description, version,
           skills_json, input_modes_json, output_modes_json, capabilities_json,
           fetched_at, etag, raw_card_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(endpoint_id) DO UPDATE SET
           protocol_version = excluded.protocol_version,
           agent_name = excluded.agent_name,
           description = excluded.description,
           version = excluded.version,
           skills_json = excluded.skills_json,
           input_modes_json = excluded.input_modes_json,
           output_modes_json = excluded.output_modes_json,
           capabilities_json = excluded.capabilities_json,
           fetched_at = excluded.fetched_at,
           etag = excluded.etag,
           raw_card_json = excluded.raw_card_json`,
      )
      .run(
        snapshot.endpointId,
        snapshot.protocolVersion ?? null,
        snapshot.agentName,
        snapshot.description ?? null,
        snapshot.version ?? null,
        JSON.stringify(snapshot.skills),
        JSON.stringify(snapshot.inputModes),
        JSON.stringify(snapshot.outputModes),
        JSON.stringify(snapshot.capabilities),
        snapshot.fetchedAt,
        snapshot.etag ?? null,
        snapshot.rawCardJson,
      );
    const refreshed = await this.getCardSnapshot(snapshot.endpointId);
    if (!refreshed) {
      throw new Error(`A2A card snapshot not found: ${snapshot.endpointId}`);
    }
    return refreshed;
  }

  private writeEndpoint(endpoint: A2AEndpoint, mode: "insert" | "update"): void {
    if (mode === "insert") {
      this.db
        .prepare(
          `INSERT INTO a2a_endpoints
            (id, name, base_url, agent_card_url, preferred_transport, enabled,
             trusted, auth_secret_ref, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          endpoint.id,
          endpoint.name,
          endpoint.baseUrl,
          endpoint.agentCardUrl,
          endpoint.preferredTransport,
          endpoint.enabled ? 1 : 0,
          endpoint.trusted ? 1 : 0,
          endpoint.authSecretRef ?? null,
          endpoint.createdAt,
          endpoint.updatedAt,
        );
      return;
    }

    this.db
      .prepare(
        `UPDATE a2a_endpoints SET
           name = ?, base_url = ?, agent_card_url = ?, preferred_transport = ?,
           enabled = ?, trusted = ?, auth_secret_ref = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        endpoint.name,
        endpoint.baseUrl,
        endpoint.agentCardUrl,
        endpoint.preferredTransport,
        endpoint.enabled ? 1 : 0,
        endpoint.trusted ? 1 : 0,
        endpoint.authSecretRef ?? null,
        endpoint.updatedAt,
        endpoint.id,
      );
  }
}

