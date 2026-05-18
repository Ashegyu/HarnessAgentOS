import type { LearningTrace, LearningTracePatch } from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";

export interface LearningTraceRepository {
  /** Create a fresh trace row keyed by taskRunId. */
  create(input: { taskRunId: string }): Promise<LearningTrace>;
  /** Patch an existing trace; ignores fields that are undefined. */
  update(id: string, patch: LearningTracePatch): Promise<LearningTrace>;
  get(id: string): Promise<LearningTrace | null>;
  getByTaskRun(taskRunId: string): Promise<LearningTrace | null>;
  /** Most recent first (by createdAt desc). */
  list(): Promise<LearningTrace[]>;
  sumCostByTaskRun(taskRunId: string): Promise<number>;
  sumCostByDay(input: {
    profileId?: string;
    isoDate: string;
  }): Promise<number>;
}

interface LearningTraceRow {
  id: string;
  task_run_id: string;
  selected_model: string | null;
  selected_capabilities_json: string;
  reward: number | null;
  cost_estimate: number | null;
  latency_ms: number | null;
  success: number | null;
  failure_reason: string | null;
  created_at: string;
}

const rowToTrace = (r: LearningTraceRow): LearningTrace => {
  let selectedCapabilities: string[] = [];
  try {
    selectedCapabilities = JSON.parse(r.selected_capabilities_json) as string[];
  } catch {
    selectedCapabilities = [];
  }
  const t: LearningTrace = {
    id: r.id,
    taskRunId: r.task_run_id,
    selectedCapabilities,
    createdAt: r.created_at,
  };
  if (r.selected_model !== null) t.selectedModel = r.selected_model;
  if (r.reward !== null) t.reward = r.reward;
  if (r.cost_estimate !== null) t.costEstimate = r.cost_estimate;
  if (r.latency_ms !== null) t.latencyMs = r.latency_ms;
  if (r.success !== null) t.success = r.success === 1;
  if (r.failure_reason !== null) t.failureReason = r.failure_reason;
  return t;
};

export class SqliteLearningTraceRepository implements LearningTraceRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: { taskRunId: string }): Promise<LearningTrace> {
    const trace: LearningTrace = {
      id: newId("learningTrace"),
      taskRunId: input.taskRunId,
      selectedCapabilities: [],
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO learning_traces(id, task_run_id, selected_model, selected_capabilities_json,
            reward, cost_estimate, latency_ms, success, failure_reason, created_at)
         VALUES(@id, @taskRunId, NULL, @selectedCapabilitiesJson, NULL, NULL, NULL, NULL, NULL, @createdAt)`,
      )
      .run({
        id: trace.id,
        taskRunId: trace.taskRunId,
        selectedCapabilitiesJson: JSON.stringify(trace.selectedCapabilities),
        createdAt: trace.createdAt,
      });
    return trace;
  }

  async update(id: string, patch: LearningTracePatch): Promise<LearningTrace> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`LearningTrace ${id} not found`);
    const next: LearningTrace = { ...existing };
    if (patch.selectedModel !== undefined)
      next.selectedModel = patch.selectedModel;
    if (patch.selectedCapabilities !== undefined)
      next.selectedCapabilities = patch.selectedCapabilities;
    if (patch.reward !== undefined) next.reward = patch.reward;
    if (patch.costEstimate !== undefined) next.costEstimate = patch.costEstimate;
    if (patch.latencyMs !== undefined) next.latencyMs = patch.latencyMs;
    if (patch.success !== undefined) next.success = patch.success;
    if (patch.failureReason !== undefined)
      next.failureReason = patch.failureReason;
    this.db
      .prepare(
        `UPDATE learning_traces SET
            selected_model = @selectedModel,
            selected_capabilities_json = @selectedCapabilitiesJson,
            reward = @reward,
            cost_estimate = @costEstimate,
            latency_ms = @latencyMs,
            success = @success,
            failure_reason = @failureReason
          WHERE id = @id`,
      )
      .run({
        id: next.id,
        selectedModel: next.selectedModel ?? null,
        selectedCapabilitiesJson: JSON.stringify(next.selectedCapabilities),
        reward: next.reward ?? null,
        costEstimate: next.costEstimate ?? null,
        latencyMs: next.latencyMs ?? null,
        success:
          next.success === undefined ? null : next.success ? 1 : 0,
        failureReason: next.failureReason ?? null,
      });
    return next;
  }

  async get(id: string): Promise<LearningTrace | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, selected_model, selected_capabilities_json,
                reward, cost_estimate, latency_ms, success, failure_reason, created_at
         FROM learning_traces WHERE id = ?`,
      )
      .get(id) as LearningTraceRow | undefined;
    return row ? rowToTrace(row) : null;
  }

  async getByTaskRun(taskRunId: string): Promise<LearningTrace | null> {
    const row = this.db
      .prepare(
        `SELECT id, task_run_id, selected_model, selected_capabilities_json,
                reward, cost_estimate, latency_ms, success, failure_reason, created_at
         FROM learning_traces WHERE task_run_id = ?
         ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1`,
      )
      .get(taskRunId) as LearningTraceRow | undefined;
    return row ? rowToTrace(row) : null;
  }

  async list(): Promise<LearningTrace[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_run_id, selected_model, selected_capabilities_json,
                reward, cost_estimate, latency_ms, success, failure_reason, created_at
         FROM learning_traces
         ORDER BY datetime(created_at) DESC, rowid DESC`,
      )
      .all() as LearningTraceRow[];
    return rows.map(rowToTrace);
  }

  async sumCostByTaskRun(taskRunId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_estimate), 0) AS total
         FROM learning_traces
         WHERE task_run_id = ? AND cost_estimate IS NOT NULL`,
      )
      .get(taskRunId) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  async sumCostByDay(input: {
    profileId?: string;
    isoDate: string;
  }): Promise<number> {
    void input.profileId;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_estimate), 0) AS total
         FROM learning_traces
         WHERE substr(created_at, 1, 10) = ?
           AND cost_estimate IS NOT NULL`,
      )
      .get(input.isoDate) as { total: number } | undefined;
    return row?.total ?? 0;
  }
}
