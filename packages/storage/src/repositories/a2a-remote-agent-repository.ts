import type {
  A2AAgentCardSnapshot,
  A2AEndpoint,
  A2ARemoteTaskRef,
} from "@harness/core";
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
  getRemoteTaskRef(invocationId: string): Promise<A2ARemoteTaskRef | null>;
  listRemoteTaskRefsByEndpoint(endpointId: string): Promise<A2ARemoteTaskRef[]>;
  upsertRemoteTaskRef(ref: A2ARemoteTaskRef): Promise<A2ARemoteTaskRef>;
  ensureSeed(): Promise<void>;
}

interface RemoteAgentSeed {
  id: string;
  name: string;
  legacyName: string;
  port: number;
  description: string;
  skill: A2AAgentCardSnapshot["skills"][number];
}

const REMOTE_AGENT_SEEDS: readonly RemoteAgentSeed[] = [
  { id: "a2a_seed_code_review", legacyName: "Code Review Agent", name: "코드 리뷰 에이전트", port: 7411, description: "변경 사항의 정확성, 유지보수성, 회귀 위험을 검토합니다.", skill: { id: "code-review", name: "코드 리뷰", description: "변경 내용을 분석하고 우선순위가 있는 검토 결과를 반환합니다.", tags: ["review", "quality"] } },
  { id: "a2a_seed_test_automation", legacyName: "Test Automation Agent", name: "테스트 자동화 에이전트", port: 7412, description: "단위·통합·E2E 테스트를 설계하고 실행합니다.", skill: { id: "test-automation", name: "테스트 자동화", description: "테스트 계획을 만들고 재현 가능한 결과를 보고합니다.", tags: ["test", "automation"] } },
  { id: "a2a_seed_security_audit", legacyName: "Security Audit Agent", name: "보안 감사 에이전트", port: 7413, description: "신뢰 경계, 보안정보 처리, 입력 검증 위험을 찾습니다.", skill: { id: "security-audit", name: "보안 감사", description: "코드와 아키텍처의 악용 가능한 위험을 검토합니다.", tags: ["security", "audit"] } },
  { id: "a2a_seed_performance", legacyName: "Performance Agent", name: "성능 분석 에이전트", port: 7414, description: "변경을 제안하기 전에 지연 시간, CPU, 메모리와 반복 작업을 측정합니다.", skill: { id: "performance", name: "성능 분석", description: "병목 구간을 측정하고 근거가 있는 최적화를 제안합니다.", tags: ["performance", "profiling"] } },
  { id: "a2a_seed_frontend", legacyName: "Frontend UX Agent", name: "프론트엔드 UX 에이전트", port: 7415, description: "접근성과 반응성을 갖춘 일관된 사용자 인터페이스를 만듭니다.", skill: { id: "frontend-ux", name: "프론트엔드 UX", description: "제품 수준의 UI 경험을 검토하고 구현합니다.", tags: ["frontend", "ux"] } },
  { id: "a2a_seed_backend", legacyName: "Backend API Agent", name: "백엔드 API 에이전트", port: 7416, description: "서비스 경계, API, 검증과 오류 처리를 설계합니다.", skill: { id: "backend-api", name: "백엔드 API", description: "견고한 백엔드 서비스를 계획하고 구현합니다.", tags: ["backend", "api"] } },
  { id: "a2a_seed_database", legacyName: "Database Agent", name: "데이터베이스 에이전트", port: 7417, description: "스키마, 쿼리, 마이그레이션과 트랜잭션 정확성을 검토합니다.", skill: { id: "database", name: "데이터베이스 엔지니어링", description: "안전한 마이그레이션과 효율적인 저장 흐름을 설계합니다.", tags: ["database", "migration"] } },
  { id: "a2a_seed_documentation", legacyName: "Documentation Agent", name: "문서화 에이전트", port: 7418, description: "구현 세부사항을 간결한 운영자·개발자 문서로 정리합니다.", skill: { id: "documentation", name: "문서화", description: "정확한 안내서, 참조 문서와 릴리스 노트를 작성합니다.", tags: ["docs", "knowledge"] } },
  { id: "a2a_seed_release", legacyName: "Release Agent", name: "릴리스 에이전트", port: 7419, description: "릴리스 준비 상태, 패키징, 변경 기록과 롤백 근거를 점검합니다.", skill: { id: "release", name: "릴리스 준비", description: "프로덕션 릴리스 후보를 준비하고 검증합니다.", tags: ["release", "devops"] } },
  { id: "a2a_seed_research", legacyName: "Research Agent", name: "리서치 에이전트", port: 7420, description: "1차 출처 근거를 수집하고 구현 선택지를 비교합니다.", skill: { id: "research", name: "기술 조사", description: "출처에 근거한 기술 권고안을 작성합니다.", tags: ["research", "architecture"] } },
];

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

interface RemoteTaskRow {
  invocation_id: string;
  endpoint_id: string;
  remote_task_id: string | null;
  remote_context_id: string | null;
  state: A2ARemoteTaskRef["state"];
  last_event_at: string | null;
}

const ENDPOINT_SELECT = `SELECT id, name, base_url, agent_card_url,
       preferred_transport, enabled, trusted, auth_secret_ref,
       created_at, updated_at
  FROM a2a_endpoints`;

const CARD_SELECT = `SELECT endpoint_id, protocol_version, agent_name,
       description, version, skills_json, input_modes_json, output_modes_json,
       capabilities_json, fetched_at, etag, raw_card_json
  FROM a2a_agent_card_snapshots`;

const REMOTE_TASK_SELECT = `SELECT invocation_id, endpoint_id, remote_task_id,
       remote_context_id, state, last_event_at
  FROM a2a_remote_tasks`;

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

const rowToRemoteTask = (row: RemoteTaskRow): A2ARemoteTaskRef => {
  const ref: A2ARemoteTaskRef = {
    invocationId: row.invocation_id,
    endpointId: row.endpoint_id,
    state: row.state,
  };
  if (row.remote_task_id !== null) ref.remoteTaskId = row.remote_task_id;
  if (row.remote_context_id !== null) {
    ref.remoteContextId = row.remote_context_id;
  }
  if (row.last_event_at !== null) ref.lastEventAt = row.last_event_at;
  return ref;
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

  async ensureSeed(): Promise<void> {
    const existing = await this.listEndpoints();
    const existingIds = new Set(existing.map((endpoint) => endpoint.id));
    const existingNames = new Set(
      existing.map((endpoint) => endpoint.name.trim().toLowerCase()),
    );
    const now = nowIso();

    for (const seed of REMOTE_AGENT_SEEDS) {
      let endpoint = existing.find((item) => item.id === seed.id);
      if (endpoint?.name === seed.legacyName) {
        endpoint = await this.upsertEndpoint({ ...endpoint, name: seed.name });
      }
      if (!endpoint && !existingNames.has(seed.name.toLowerCase())) {
        const baseUrl = `http://127.0.0.1:${seed.port}`;
        endpoint = {
          id: seed.id,
          name: seed.name,
          baseUrl,
          agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
          preferredTransport: "json-rpc",
          enabled: false,
          trusted: false,
          createdAt: now,
          updatedAt: now,
        };
        this.writeEndpoint(endpoint, "insert");
        existingIds.add(endpoint.id);
        existingNames.add(endpoint.name.toLowerCase());
      }
      if (!endpoint || !existingIds.has(endpoint.id)) continue;
      const existingCard = await this.getCardSnapshot(endpoint.id);
      if (
        existingCard &&
        existingCard.agentName !== seed.legacyName &&
        existingCard.agentName !== seed.name
      ) {
        continue;
      }

      const rawCard = {
        protocolVersion: "0.3.0",
        name: seed.name,
        description: seed.description,
        version: "1.0.0",
        skills: [seed.skill],
        harnessLocalization: {
          key: builtInLocalizationKey("remoteAgent", seed.id, "a2a_seed_"),
          en: { name: seed.legacyName },
          ko: { name: seed.name },
        },
      };
      await this.upsertCardSnapshot({
        endpointId: endpoint.id,
        protocolVersion: "0.3.0",
        agentName: seed.name,
        description: seed.description,
        version: "1.0.0",
        skills: [seed.skill],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json"],
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: true,
        },
        fetchedAt: now,
        rawCardJson: JSON.stringify(rawCard),
      });
    }
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

  async getRemoteTaskRef(
    invocationId: string,
  ): Promise<A2ARemoteTaskRef | null> {
    const row = this.db
      .prepare<[string], RemoteTaskRow>(
        `${REMOTE_TASK_SELECT} WHERE invocation_id = ?`,
      )
      .get(invocationId);
    return row ? rowToRemoteTask(row) : null;
  }

  async listRemoteTaskRefsByEndpoint(
    endpointId: string,
  ): Promise<A2ARemoteTaskRef[]> {
    const rows = this.db
      .prepare<[string], RemoteTaskRow>(
        `${REMOTE_TASK_SELECT}
         WHERE endpoint_id = ?
         ORDER BY datetime(last_event_at) DESC, invocation_id ASC`,
      )
      .all(endpointId);
    return rows.map(rowToRemoteTask);
  }

  async upsertRemoteTaskRef(
    ref: A2ARemoteTaskRef,
  ): Promise<A2ARemoteTaskRef> {
    this.db
      .prepare(
        `INSERT INTO a2a_remote_tasks
          (invocation_id, endpoint_id, remote_task_id, remote_context_id,
           state, last_event_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(invocation_id) DO UPDATE SET
           endpoint_id = excluded.endpoint_id,
           remote_task_id = excluded.remote_task_id,
           remote_context_id = excluded.remote_context_id,
           state = excluded.state,
           last_event_at = excluded.last_event_at`,
      )
      .run(
        ref.invocationId,
        ref.endpointId,
        ref.remoteTaskId ?? null,
        ref.remoteContextId ?? null,
        ref.state,
        ref.lastEventAt ?? null,
      );
    const refreshed = await this.getRemoteTaskRef(ref.invocationId);
    if (!refreshed) {
      throw new Error(`A2A remote task ref not found: ${ref.invocationId}`);
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

const builtInLocalizationKey = (
  domain: string,
  id: string,
  prefix: string,
): string => {
  const words = id.slice(prefix.length).split("_");
  const suffix = words
    .map((word, index) =>
      index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
    )
    .join("");
  return `builtin.${domain}.${suffix}`;
};
