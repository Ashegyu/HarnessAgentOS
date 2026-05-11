import type {
  AgentInvocation,
  AgentInvocationStatus,
  CreateAgentInvocationInput,
  UpdateAgentInvocationPatch,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface AgentInvocationRepository {
  create(input: CreateAgentInvocationInput): Promise<AgentInvocation>;
  get(id: string): Promise<AgentInvocation | null>;
  update(
    id: string,
    patch: UpdateAgentInvocationPatch,
  ): Promise<AgentInvocation>;
  listByTaskRun(taskRunId: string): Promise<AgentInvocation[]>;
  getLatestForTaskRun(taskRunId: string): Promise<AgentInvocation | null>;
}

interface AgentInvocationRow {
  id: string;
  task_run_id: string;
  step_id: string | null;
  provider: "claude" | "codex";
  model: string;
  status: AgentInvocationStatus;
  prompt_artifact_id: string;
  raw_output_artifact_id: string | null;
  parsed_plan_artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  latency_ms: number | null;
  cost_estimate: number | null;
  created_at: string;
  updated_at: string;
}

const rowToInvocation = (r: AgentInvocationRow): AgentInvocation => {
  const inv: AgentInvocation = {
    id: r.id,
    taskRunId: r.task_run_id,
    provider: r.provider,
    model: r.model,
    status: r.status,
    promptArtifactId: r.prompt_artifact_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.step_id !== null) inv.stepId = r.step_id;
  if (r.raw_output_artifact_id !== null)
    inv.rawOutputArtifactId = r.raw_output_artifact_id;
  if (r.parsed_plan_artifact_id !== null)
    inv.parsedPlanArtifactId = r.parsed_plan_artifact_id;
  if (r.error_code !== null) inv.errorCode = r.error_code;
  if (r.error_message !== null) inv.errorMessage = r.error_message;
  if (r.started_at !== null) inv.startedAt = r.started_at;
  if (r.finished_at !== null) inv.finishedAt = r.finished_at;
  if (r.latency_ms !== null) inv.latencyMs = r.latency_ms;
  if (r.cost_estimate !== null) inv.costEstimate = r.cost_estimate;
  return inv;
};

export class SqliteAgentInvocationRepository
  implements AgentInvocationRepository
{
  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
  }

  async create(input: CreateAgentInvocationInput): Promise<AgentInvocation> {
    const now = nowIso();
    const inv: AgentInvocation = {
      id: newId("agentInvocation"),
      taskRunId: input.taskRunId,
      provider: input.provider,
      model: input.model,
      status: "queued",
      promptArtifactId: input.promptArtifactId,
      createdAt: now,
      updatedAt: now,
    };
    if (input.stepId !== undefined) inv.stepId = input.stepId;
    this.db
      .prepare(
        `INSERT INTO agent_invocations(
            id, task_run_id, step_id, provider, model, status,
            prompt_artifact_id, raw_output_artifact_id, parsed_plan_artifact_id,
            error_code, error_message, started_at, finished_at, latency_ms,
            cost_estimate, created_at, updated_at)
         VALUES(@id, @taskRunId, @stepId, @provider, @model, @status,
                @promptArtifactId, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, @createdAt, @updatedAt)`,
      )
      .run({
        id: inv.id,
        taskRunId: inv.taskRunId,
        stepId: inv.stepId ?? null,
        provider: inv.provider,
        model: inv.model,
        status: inv.status,
        promptArtifactId: inv.promptArtifactId,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      });
    return inv;
  }

  async get(id: string): Promise<AgentInvocation | null> {
    const row = this.db
      .prepare(`SELECT * FROM agent_invocations WHERE id = ?`)
      .get(id) as AgentInvocationRow | undefined;
    return row ? rowToInvocation(row) : null;
  }

  async update(
    id: string,
    patch: UpdateAgentInvocationPatch,
  ): Promise<AgentInvocation> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`AgentInvocation ${id} not found`);
    const next: AgentInvocation = { ...existing };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.stepId !== undefined) next.stepId = patch.stepId;
    if (patch.rawOutputArtifactId !== undefined) {
      if (patch.rawOutputArtifactId === null) delete next.rawOutputArtifactId;
      else next.rawOutputArtifactId = patch.rawOutputArtifactId;
    }
    if (patch.parsedPlanArtifactId !== undefined) {
      if (patch.parsedPlanArtifactId === null) delete next.parsedPlanArtifactId;
      else next.parsedPlanArtifactId = patch.parsedPlanArtifactId;
    }
    if (patch.errorCode !== undefined) {
      if (patch.errorCode === null) delete next.errorCode;
      else next.errorCode = patch.errorCode;
    }
    if (patch.errorMessage !== undefined) {
      if (patch.errorMessage === null) delete next.errorMessage;
      else next.errorMessage = patch.errorMessage;
    }
    if (patch.startedAt !== undefined) {
      if (patch.startedAt === null) delete next.startedAt;
      else next.startedAt = patch.startedAt;
    }
    if (patch.finishedAt !== undefined) {
      if (patch.finishedAt === null) delete next.finishedAt;
      else next.finishedAt = patch.finishedAt;
    }
    if (patch.latencyMs !== undefined) {
      if (patch.latencyMs === null) delete next.latencyMs;
      else next.latencyMs = patch.latencyMs;
    }
    if (patch.costEstimate !== undefined) {
      if (patch.costEstimate === null) delete next.costEstimate;
      else next.costEstimate = patch.costEstimate;
    }
    next.updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE agent_invocations SET
            status = @status,
            step_id = @stepId,
            raw_output_artifact_id = @rawOutputArtifactId,
            parsed_plan_artifact_id = @parsedPlanArtifactId,
            error_code = @errorCode,
            error_message = @errorMessage,
            started_at = @startedAt,
            finished_at = @finishedAt,
            latency_ms = @latencyMs,
            cost_estimate = @costEstimate,
            updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id: next.id,
        status: next.status,
        stepId: next.stepId ?? null,
        rawOutputArtifactId: next.rawOutputArtifactId ?? null,
        parsedPlanArtifactId: next.parsedPlanArtifactId ?? null,
        errorCode: next.errorCode ?? null,
        errorMessage: next.errorMessage ?? null,
        startedAt: next.startedAt ?? null,
        finishedAt: next.finishedAt ?? null,
        latencyMs: next.latencyMs ?? null,
        costEstimate: next.costEstimate ?? null,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  async listByTaskRun(taskRunId: string): Promise<AgentInvocation[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_invocations
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) DESC, rowid DESC`,
      )
      .all(taskRunId) as AgentInvocationRow[];
    return rows.map(rowToInvocation);
  }

  async getLatestForTaskRun(
    taskRunId: string,
  ): Promise<AgentInvocation | null> {
    const list = await this.listByTaskRun(taskRunId);
    return list[0] ?? null;
  }
}
