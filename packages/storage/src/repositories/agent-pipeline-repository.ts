import {
  MAX_PIPELINE_STEPS,
  isAgentPipelineStep,
  type AgentPipeline,
  type AgentPipelineStep,
  type CreateAgentPipelineInput,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import type { AgentProfileRepository } from "./agent-profile-repository.ts";

/**
 * Repository for AgentPipeline templates. Steps are stored as a JSON
 * column on `agent_pipelines.steps_json`; SQLite enforces non-empty via
 * a CHECK on `json_array_length`. The cross-table integrity (each step's
 * `agentProfileId` must reference an existing AgentProfile row) is
 * enforced HERE — JSON columns can't carry FK constraints. Both create
 * and update go through `validate()` so the invariant holds at every
 * write boundary.
 */
export interface AgentPipelineRepository {
  list(): Promise<AgentPipeline[]>;
  get(id: string): Promise<AgentPipeline | null>;
  create(input: CreateAgentPipelineInput): Promise<AgentPipeline>;
  update(pipeline: AgentPipeline): Promise<AgentPipeline>;
  delete(id: string): Promise<void>;
  findByReferencedAgentProfileId(profileId: string): Promise<AgentPipeline[]>;
}

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  steps_json: string;
  created_at: string;
  updated_at: string;
}

const rowToPipeline = (row: PipelineRow): AgentPipeline => ({
  id: row.id,
  name: row.name,
  description: row.description,
  steps: JSON.parse(row.steps_json) as AgentPipelineStep[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `SELECT id, name, description, steps_json, created_at, updated_at
  FROM agent_pipelines`;

export class SqliteAgentPipelineRepository implements AgentPipelineRepository {
  private readonly db: HarnessDb;
  private readonly profiles: AgentProfileRepository;

  constructor(db: HarnessDb, profiles: AgentProfileRepository) {
    this.db = db;
    this.profiles = profiles;
  }

  async list(): Promise<AgentPipeline[]> {
    const rows = this.db
      .prepare<[], PipelineRow>(`${SELECT} ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToPipeline);
  }

  async get(id: string): Promise<AgentPipeline | null> {
    const row = this.db
      .prepare<[string], PipelineRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? rowToPipeline(row) : null;
  }

  async create(input: CreateAgentPipelineInput): Promise<AgentPipeline> {
    await this.validate(input.name, input.steps);
    const id = newId("agentPipeline");
    const now = nowIso();
    const pipeline: AgentPipeline = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_pipelines
          (id, name, description, steps_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        pipeline.id,
        pipeline.name,
        pipeline.description,
        JSON.stringify(pipeline.steps),
        pipeline.createdAt,
        pipeline.updatedAt,
      );
    return pipeline;
  }

  async update(pipeline: AgentPipeline): Promise<AgentPipeline> {
    await this.validate(pipeline.name, pipeline.steps);
    const updated: AgentPipeline = { ...pipeline, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE agent_pipelines
           SET name = ?, description = ?, steps_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updated.name,
        updated.description,
        JSON.stringify(updated.steps),
        updated.updatedAt,
        updated.id,
      );
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM agent_pipelines WHERE id = ?`).run(id);
  }

  async findByReferencedAgentProfileId(
    profileId: string,
  ): Promise<AgentPipeline[]> {
    // SQLite's json_each() lets us search inside the array without
    // pulling every row into JS.
    const rows = this.db
      .prepare<[string], PipelineRow>(
        `${SELECT}
           WHERE EXISTS (
             SELECT 1 FROM json_each(steps_json) je
              WHERE json_extract(je.value, '$.agentProfileId') = ?
           )
         ORDER BY created_at ASC`,
      )
      .all(profileId);
    return rows.map(rowToPipeline);
  }

  private async validate(
    name: string,
    steps: readonly AgentPipelineStep[],
  ): Promise<void> {
    if (name.trim().length === 0) {
      throw new Error("AgentPipeline.name must be non-empty");
    }
    if (!Array.isArray(steps) || steps.length < 1) {
      throw new Error("AgentPipeline.steps must contain at least one step");
    }
    if (steps.length > MAX_PIPELINE_STEPS) {
      throw new Error(
        `AgentPipeline.steps exceeds MAX_PIPELINE_STEPS (${MAX_PIPELINE_STEPS})`,
      );
    }
    for (const [i, step] of steps.entries()) {
      if (!isAgentPipelineStep(step)) {
        throw new Error(`AgentPipeline.steps[${i}] is malformed`);
      }
      const profile = await this.profiles.get(step.agentProfileId);
      if (!profile) {
        throw new Error(
          `AgentPipeline.steps[${i}].agentProfileId references unknown profile: ${step.agentProfileId}`,
        );
      }
    }
  }
}
