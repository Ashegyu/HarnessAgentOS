import type {
  CreateEvolutionCandidateInput,
  CreateInstinctInput,
  CreateObservationInput,
  EvolutionCandidate,
  EvolutionCandidateStatus,
  Instinct,
  InstinctStatus,
  Observation,
  ObservationSource,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface ObservationRepository {
  create(input: CreateObservationInput): Promise<Observation>;
  list(input?: {
    projectKey?: string;
    taskRunId?: string;
    limit?: number;
  }): Promise<Observation[]>;
  get(id: string): Promise<Observation | null>;
}

export interface InstinctRepository {
  create(input: CreateInstinctInput): Promise<Instinct>;
  list(input?: {
    projectKey?: string;
    includeDisabled?: boolean;
  }): Promise<Instinct[]>;
  get(id: string): Promise<Instinct | null>;
  updateStatus(id: string, status: InstinctStatus): Promise<Instinct>;
}

export interface EvolutionCandidateRepository {
  create(input: CreateEvolutionCandidateInput): Promise<EvolutionCandidate>;
  list(input?: {
    projectKey?: string;
    status?: EvolutionCandidateStatus;
  }): Promise<EvolutionCandidate[]>;
  get(id: string): Promise<EvolutionCandidate | null>;
  updateStatus(
    id: string,
    status: EvolutionCandidateStatus,
  ): Promise<EvolutionCandidate>;
}

interface ObservationRow {
  id: string;
  task_run_id: string | null;
  thread_id: string | null;
  project_key: string | null;
  source: ObservationSource;
  event_type: string;
  signal: string;
  summary: string;
  payload_json: string;
  created_at: string;
}

interface InstinctRow {
  id: string;
  project_key: string | null;
  scope: Instinct["scope"];
  title: string;
  rule: string;
  rationale: string;
  confidence: number;
  status: InstinctStatus;
  source_observation_ids_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

interface EvolutionCandidateRow {
  id: string;
  project_key: string | null;
  title: string;
  proposed_rule: string;
  rationale: string;
  confidence: number;
  status: EvolutionCandidateStatus;
  observation_ids_json: string;
  created_at: string;
  updated_at: string;
}

export class SqliteObservationRepository implements ObservationRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(input: CreateObservationInput): Promise<Observation> {
    const observation: Observation = {
      id: newId("observation"),
      source: input.source,
      eventType: input.eventType,
      signal: input.signal,
      summary: input.summary,
      payload: input.payload ?? {},
      createdAt: nowIso(),
    };
    if (input.taskRunId) observation.taskRunId = input.taskRunId;
    if (input.threadId) observation.threadId = input.threadId;
    if (input.projectKey) observation.projectKey = input.projectKey;

    this.db
      .prepare(
        `INSERT INTO observations(
           id, task_run_id, thread_id, project_key, source, event_type,
           signal, summary, payload_json, created_at
         ) VALUES(
           @id, @taskRunId, @threadId, @projectKey, @source, @eventType,
           @signal, @summary, @payloadJson, @createdAt
         )`,
      )
      .run({
        id: observation.id,
        taskRunId: observation.taskRunId ?? null,
        threadId: observation.threadId ?? null,
        projectKey: observation.projectKey ?? null,
        source: observation.source,
        eventType: observation.eventType,
        signal: observation.signal,
        summary: observation.summary,
        payloadJson: JSON.stringify(observation.payload),
        createdAt: observation.createdAt,
      });
    return observation;
  }

  async list(input: {
    projectKey?: string;
    taskRunId?: string;
    limit?: number;
  } = {}): Promise<Observation[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.projectKey !== undefined) {
      where.push("project_key = @projectKey");
      params.projectKey = input.projectKey;
    }
    if (input.taskRunId !== undefined) {
      where.push("task_run_id = @taskRunId");
      params.taskRunId = input.taskRunId;
    }
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    params.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, thread_id, project_key, source, event_type,
                signal, summary, payload_json, created_at
         FROM observations
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY datetime(created_at) DESC, rowid DESC
         LIMIT @limit`,
      )
      .all(params) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  async get(id: string): Promise<Observation | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, thread_id, project_key, source, event_type,
                signal, summary, payload_json, created_at
         FROM observations WHERE id = ?`,
      )
      .get(id) as ObservationRow | undefined;
    return row ? rowToObservation(row) : null;
  }
}

export class SqliteInstinctRepository implements InstinctRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(input: CreateInstinctInput): Promise<Instinct> {
    const now = nowIso();
    const instinct: Instinct = {
      id: newId("instinct"),
      scope: input.scope,
      title: input.title,
      rule: input.rule,
      rationale: input.rationale,
      confidence: clampConfidence(input.confidence),
      status: input.status ?? "active",
      sourceObservationIds: input.sourceObservationIds,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.projectKey) instinct.projectKey = input.projectKey;
    this.db
      .prepare(
        `INSERT INTO instincts(
           id, project_key, scope, title, rule, rationale, confidence, status,
           source_observation_ids_json, tags_json, created_at, updated_at
         ) VALUES(
           @id, @projectKey, @scope, @title, @rule, @rationale, @confidence, @status,
           @sourceObservationIdsJson, @tagsJson, @createdAt, @updatedAt
         )`,
      )
      .run({
        id: instinct.id,
        projectKey: instinct.projectKey ?? null,
        scope: instinct.scope,
        title: instinct.title,
        rule: instinct.rule,
        rationale: instinct.rationale,
        confidence: instinct.confidence,
        status: instinct.status,
        sourceObservationIdsJson: JSON.stringify(instinct.sourceObservationIds),
        tagsJson: JSON.stringify(instinct.tags),
        createdAt: instinct.createdAt,
        updatedAt: instinct.updatedAt,
      });
    return instinct;
  }

  async list(input: {
    projectKey?: string;
    includeDisabled?: boolean;
  } = {}): Promise<Instinct[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.projectKey !== undefined) {
      where.push("(project_key = @projectKey OR scope = 'global')");
      params.projectKey = input.projectKey;
    }
    if (input.includeDisabled !== true) {
      where.push("status = 'active'");
    }
    const rows = this.db
      .prepare(
        `SELECT id, project_key, scope, title, rule, rationale, confidence, status,
                source_observation_ids_json, tags_json, created_at, updated_at
         FROM instincts
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY confidence DESC, datetime(updated_at) DESC, rowid DESC`,
      )
      .all(params) as InstinctRow[];
    return rows.map(rowToInstinct);
  }

  async get(id: string): Promise<Instinct | null> {
    const row = this.db
      .prepare(
        `SELECT id, project_key, scope, title, rule, rationale, confidence, status,
                source_observation_ids_json, tags_json, created_at, updated_at
         FROM instincts WHERE id = ?`,
      )
      .get(id) as InstinctRow | undefined;
    return row ? rowToInstinct(row) : null;
  }

  async updateStatus(id: string, status: InstinctStatus): Promise<Instinct> {
    const updatedAt = nowIso();
    this.db
      .prepare(`UPDATE instincts SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, updatedAt, id);
    const next = await this.get(id);
    if (!next) throw new Error(`Instinct ${id} not found`);
    return next;
  }
}

export class SqliteEvolutionCandidateRepository
  implements EvolutionCandidateRepository
{
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(
    input: CreateEvolutionCandidateInput,
  ): Promise<EvolutionCandidate> {
    const now = nowIso();
    const candidate: EvolutionCandidate = {
      id: newId("evolutionCandidate"),
      title: input.title,
      proposedRule: input.proposedRule,
      rationale: input.rationale,
      confidence: clampConfidence(input.confidence),
      status: input.status ?? "pending",
      observationIds: input.observationIds,
      createdAt: now,
      updatedAt: now,
    };
    if (input.projectKey) candidate.projectKey = input.projectKey;
    this.db
      .prepare(
        `INSERT INTO evolution_candidates(
           id, project_key, title, proposed_rule, rationale, confidence, status,
           observation_ids_json, created_at, updated_at
         ) VALUES(
           @id, @projectKey, @title, @proposedRule, @rationale, @confidence, @status,
           @observationIdsJson, @createdAt, @updatedAt
         )`,
      )
      .run({
        id: candidate.id,
        projectKey: candidate.projectKey ?? null,
        title: candidate.title,
        proposedRule: candidate.proposedRule,
        rationale: candidate.rationale,
        confidence: candidate.confidence,
        status: candidate.status,
        observationIdsJson: JSON.stringify(candidate.observationIds),
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    return candidate;
  }

  async list(input: {
    projectKey?: string;
    status?: EvolutionCandidateStatus;
  } = {}): Promise<EvolutionCandidate[]> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (input.projectKey !== undefined) {
      where.push("project_key = @projectKey");
      params.projectKey = input.projectKey;
    }
    if (input.status !== undefined) {
      where.push("status = @status");
      params.status = input.status;
    }
    const rows = this.db
      .prepare(
        `SELECT id, project_key, title, proposed_rule, rationale, confidence, status,
                observation_ids_json, created_at, updated_at
         FROM evolution_candidates
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY confidence DESC, datetime(updated_at) DESC, rowid DESC`,
      )
      .all(params) as EvolutionCandidateRow[];
    return rows.map(rowToEvolutionCandidate);
  }

  async get(id: string): Promise<EvolutionCandidate | null> {
    const row = this.db
      .prepare(
        `SELECT id, project_key, title, proposed_rule, rationale, confidence, status,
                observation_ids_json, created_at, updated_at
         FROM evolution_candidates WHERE id = ?`,
      )
      .get(id) as EvolutionCandidateRow | undefined;
    return row ? rowToEvolutionCandidate(row) : null;
  }

  async updateStatus(
    id: string,
    status: EvolutionCandidateStatus,
  ): Promise<EvolutionCandidate> {
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE evolution_candidates SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, updatedAt, id);
    const next = await this.get(id);
    if (!next) throw new Error(`EvolutionCandidate ${id} not found`);
    return next;
  }
}

const rowToObservation = (r: ObservationRow): Observation => {
  const observation: Observation = {
    id: r.id,
    source: r.source,
    eventType: r.event_type,
    signal: r.signal,
    summary: r.summary,
    payload: parseObject(r.payload_json),
    createdAt: r.created_at,
  };
  if (r.task_run_id !== null) observation.taskRunId = r.task_run_id;
  if (r.thread_id !== null) observation.threadId = r.thread_id;
  if (r.project_key !== null) observation.projectKey = r.project_key;
  return observation;
};

const rowToInstinct = (r: InstinctRow): Instinct => {
  const instinct: Instinct = {
    id: r.id,
    scope: r.scope,
    title: r.title,
    rule: r.rule,
    rationale: r.rationale,
    confidence: r.confidence,
    status: r.status,
    sourceObservationIds: parseStringArray(r.source_observation_ids_json),
    tags: parseStringArray(r.tags_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.project_key !== null) instinct.projectKey = r.project_key;
  return instinct;
};

const rowToEvolutionCandidate = (
  r: EvolutionCandidateRow,
): EvolutionCandidate => {
  const candidate: EvolutionCandidate = {
    id: r.id,
    title: r.title,
    proposedRule: r.proposed_rule,
    rationale: r.rationale,
    confidence: r.confidence,
    status: r.status,
    observationIds: parseStringArray(r.observation_ids_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.project_key !== null) candidate.projectKey = r.project_key;
  return candidate;
};

const parseStringArray = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
};

const parseObject = (json: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const clampConfidence = (n: number): number =>
  Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.3));
