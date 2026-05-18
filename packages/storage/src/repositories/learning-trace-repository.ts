import type {
  LearningTraceProfileDayAggregate,
  LearningTrace,
  LearningTracePatch,
  TaskRunCostInvocationSummary,
  TaskRunCostModelBreakdown,
  TaskRunCostSummary,
} from "@harness/core";
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
  summarizeByTaskRun(taskRunId: string): Promise<TaskRunCostSummary>;
  aggregateByProfileAndDay(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
  }): Promise<LearningTraceProfileDayAggregate[]>;
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

interface CostSummaryRow {
  id: string;
  model: string | null;
  cost: number | null;
  latency_ms: number | null;
  success: number | null;
  created_at: string;
}

interface ProfileDayAggregateRow {
  profileId: string;
  dateIso: string;
  totalCostUsd: number;
  count: number;
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

  async summarizeByTaskRun(taskRunId: string): Promise<TaskRunCostSummary> {
    const rows = this.db
      .prepare(
        `SELECT id,
                selected_model AS model,
                cost_estimate AS cost,
                latency_ms,
                success,
                created_at
         FROM learning_traces
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, rowid ASC`,
      )
      .all(taskRunId) as CostSummaryRow[];

    const invocations = rows.map(rowToCostInvocation);
    return {
      taskRunId,
      totalCostUsd: invocations.reduce((sum, item) => sum + item.cost, 0),
      totalLatencyMs: invocations.reduce(
        (sum, item) => sum + item.latencyMs,
        0,
      ),
      invocationCount: invocations.length,
      perModel: summarizePerModel(invocations),
      invocations,
    };
  }

  async sumCostByTaskRun(taskRunId: string): Promise<number> {
    return (await this.summarizeByTaskRun(taskRunId)).totalCostUsd;
  }

  async aggregateByProfileAndDay(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
  }): Promise<LearningTraceProfileDayAggregate[]> {
    const rows = this.db
      .prepare(
        `SELECT profile_id AS profileId,
                date_iso AS dateIso,
                COALESCE(SUM(cost), 0) AS totalCostUsd,
                COUNT(*) AS count
         FROM (
           SELECT COALESCE(
                    (
                      SELECT ap.id
                      FROM agent_profiles ap
                      WHERE json_extract(ap.tuning_json, '$.model') = lt.selected_model
                      ORDER BY ap.is_default DESC, datetime(ap.created_at) ASC, ap.id ASC
                      LIMIT 1
                    ),
                    'unassigned'
                  ) AS profile_id,
                  substr(lt.created_at, 1, 10) AS date_iso,
                  COALESCE(lt.cost_estimate, 0) AS cost
           FROM learning_traces lt
           WHERE lt.created_at >= @sinceIso
             AND lt.created_at <= @untilIso
         )
         WHERE @profileId IS NULL OR profile_id = @profileId
         GROUP BY profile_id, date_iso
         ORDER BY date_iso ASC, profile_id ASC`,
      )
      .all({
        sinceIso: input.sinceIso,
        untilIso: input.untilIso,
        profileId: input.profileId ?? null,
      }) as ProfileDayAggregateRow[];
    return rows.map((row) => ({
      profileId: row.profileId,
      dateIso: row.dateIso,
      totalCostUsd: row.totalCostUsd,
      count: row.count,
    }));
  }

  async sumCostByDay(input: {
    profileId?: string;
    isoDate: string;
  }): Promise<number> {
    const rows = await this.aggregateByProfileAndDay({
      sinceIso: `${input.isoDate}T00:00:00.000Z`,
      untilIso: `${input.isoDate}T23:59:59.999Z`,
      ...(input.profileId ? { profileId: input.profileId } : {}),
    });
    return rows.reduce((sum, row) => sum + row.totalCostUsd, 0);
  }
}

const rowToCostInvocation = (
  row: CostSummaryRow,
): TaskRunCostInvocationSummary => {
  const summary: TaskRunCostInvocationSummary = {
    id: row.id,
    model: normalizeModel(row.model),
    cost: row.cost ?? 0,
    latencyMs: row.latency_ms ?? 0,
    createdAt: row.created_at,
  };
  if (row.success !== null) summary.success = row.success === 1;
  return summary;
};

const normalizeModel = (model: string | null): string => {
  const trimmed = model?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "unknown";
};

const summarizePerModel = (
  invocations: TaskRunCostInvocationSummary[],
): TaskRunCostModelBreakdown[] => {
  const byModel = invocations.reduce<Record<string, TaskRunCostModelBreakdown>>(
    (acc, item) => {
      const current = acc[item.model] ?? {
        model: item.model,
        cost: 0,
        latencyMs: 0,
        count: 0,
      };
      return {
        ...acc,
        [item.model]: {
          model: item.model,
          cost: current.cost + item.cost,
          latencyMs: current.latencyMs + item.latencyMs,
          count: current.count + 1,
        },
      };
    },
    {},
  );
  return Object.values(byModel).sort(
    (left, right) => right.cost - left.cost || left.model.localeCompare(right.model),
  );
};
