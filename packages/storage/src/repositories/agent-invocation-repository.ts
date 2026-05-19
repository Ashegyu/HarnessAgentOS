import type {
  AgentInvocation,
  AgentInvocationStatus,
  BudgetUsageModelSummary,
  CreateAgentInvocationInput,
  LearningTraceProfileDayAggregate,
  TaskRunCostInvocationSummary,
  TaskRunCostModelBreakdown,
  TaskRunCostSummary,
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
  listRecentWithLatency(limit?: number): Promise<AgentInvocation[]>;
  getLatestForTaskRun(taskRunId: string): Promise<AgentInvocation | null>;
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
  summarizeModelCosts(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
    limit?: number;
  }): Promise<BudgetUsageModelSummary[]>;
}

interface AgentInvocationRow {
  id: string;
  task_run_id: string;
  step_id: string | null;
  profile_id: string | null;
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
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_approximate: number | null;
  created_at: string;
  updated_at: string;
}

interface CostSummaryRow {
  id: string;
  model: string | null;
  status: AgentInvocationStatus;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_approximate: number | null;
  latency_ms: number | null;
  created_at: string;
}

interface ProfileDayAggregateRow {
  profileId: string;
  dateIso: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  count: number;
  knownCostInvocationCount: number;
  unknownCostInvocationCount: number;
  knownTokenInvocationCount: number;
  unknownTokenInvocationCount: number;
}

interface ModelCostAggregateRow {
  model: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  invocationCount: number;
  knownCostInvocationCount: number;
  unknownCostInvocationCount: number;
  knownTokenInvocationCount: number;
  unknownTokenInvocationCount: number;
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
  if (r.profile_id !== null) inv.profileId = r.profile_id;
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
  if (r.input_tokens !== null) inv.inputTokens = r.input_tokens;
  if (r.output_tokens !== null) inv.outputTokens = r.output_tokens;
  if (r.total_tokens !== null) inv.totalTokens = r.total_tokens;
  if (r.usage_approximate !== null) {
    inv.usageApproximate = r.usage_approximate === 1;
  }
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
    if (input.profileId !== undefined) inv.profileId = input.profileId;
    this.db
      .prepare(
        `INSERT INTO agent_invocations(
            id, task_run_id, step_id, profile_id, provider, model, status,
            prompt_artifact_id, raw_output_artifact_id, parsed_plan_artifact_id,
            error_code, error_message, started_at, finished_at, latency_ms,
            cost_estimate, input_tokens, output_tokens, total_tokens,
            usage_approximate, created_at, updated_at)
         VALUES(@id, @taskRunId, @stepId, @profileId, @provider, @model, @status,
                @promptArtifactId, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, @createdAt, @updatedAt)`,
      )
      .run({
        id: inv.id,
        taskRunId: inv.taskRunId,
        stepId: inv.stepId ?? null,
        profileId: inv.profileId ?? null,
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
    if (patch.inputTokens !== undefined) {
      if (patch.inputTokens === null) delete next.inputTokens;
      else next.inputTokens = patch.inputTokens;
    }
    if (patch.outputTokens !== undefined) {
      if (patch.outputTokens === null) delete next.outputTokens;
      else next.outputTokens = patch.outputTokens;
    }
    if (patch.totalTokens !== undefined) {
      if (patch.totalTokens === null) delete next.totalTokens;
      else next.totalTokens = patch.totalTokens;
    }
    if (patch.usageApproximate !== undefined) {
      if (patch.usageApproximate === null) delete next.usageApproximate;
      else next.usageApproximate = patch.usageApproximate;
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
            input_tokens = @inputTokens,
            output_tokens = @outputTokens,
            total_tokens = @totalTokens,
            usage_approximate = @usageApproximate,
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
        inputTokens: next.inputTokens ?? null,
        outputTokens: next.outputTokens ?? null,
        totalTokens: next.totalTokens ?? null,
        usageApproximate:
          next.usageApproximate === undefined
            ? null
            : next.usageApproximate
              ? 1
              : 0,
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

  async listRecentWithLatency(limit = 500): Promise<AgentInvocation[]> {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .prepare(
        `SELECT *
         FROM agent_invocations
         WHERE latency_ms IS NOT NULL
         ORDER BY datetime(COALESCE(finished_at, updated_at)) DESC, rowid DESC
         LIMIT ?`,
      )
      .all(safeLimit) as AgentInvocationRow[];
    return rows.map(rowToInvocation);
  }

  async getLatestForTaskRun(
    taskRunId: string,
  ): Promise<AgentInvocation | null> {
    const list = await this.listByTaskRun(taskRunId);
    return list[0] ?? null;
  }

  async summarizeByTaskRun(taskRunId: string): Promise<TaskRunCostSummary> {
    const rows = this.db
      .prepare(
        `SELECT id,
                model,
                status,
                cost_estimate AS cost,
                input_tokens,
                output_tokens,
                total_tokens,
                usage_approximate,
                latency_ms,
                created_at
         FROM agent_invocations
         WHERE task_run_id = ?
         ORDER BY datetime(created_at) ASC, rowid ASC`,
      )
      .all(taskRunId) as CostSummaryRow[];

    const invocations = rows.map(rowToCostInvocation);
    const unknownCostInvocationCount = invocations.filter(
      (item) => item.costKnown === false,
    ).length;
    const knownCostInvocationCount =
      invocations.length - unknownCostInvocationCount;
    const tokenCounts = summarizeTokenCompleteness(invocations);
    return {
      taskRunId,
      totalCostUsd: invocations.reduce((sum, item) => sum + item.cost, 0),
      ...tokenUsageFields(tokenCounts),
      totalLatencyMs: invocations.reduce(
        (sum, item) => sum + item.latencyMs,
        0,
      ),
      invocationCount: invocations.length,
      ...costCompletenessFields({
        knownCostInvocationCount,
        unknownCostInvocationCount,
      }),
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
                COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN cost ELSE 0 END), 0) AS totalCostUsd,
                COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE 0 END), 0) AS totalInputTokens,
                COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE 0 END), 0) AS totalOutputTokens,
                COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS totalTokens,
                COUNT(*) AS count,
                SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS knownCostInvocationCount,
                SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknownCostInvocationCount,
                SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS knownTokenInvocationCount,
                SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS unknownTokenInvocationCount
         FROM (
           SELECT COALESCE(ai.profile_id, 'unassigned') AS profile_id,
                  substr(COALESCE(ai.finished_at, ai.created_at), 1, 10) AS date_iso,
                  ai.cost_estimate AS cost,
                  ai.input_tokens,
                  ai.output_tokens,
                  ai.total_tokens
           FROM agent_invocations ai
           WHERE COALESCE(ai.finished_at, ai.created_at) >= @sinceIso
             AND COALESCE(ai.finished_at, ai.created_at) <= @untilIso
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
      ...tokenUsageFields({
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalTokens: row.totalTokens,
        knownTokenInvocationCount: row.knownTokenInvocationCount,
        unknownTokenInvocationCount: row.unknownTokenInvocationCount,
      }),
      count: row.count,
      ...costCompletenessFields({
        knownCostInvocationCount: row.knownCostInvocationCount,
        unknownCostInvocationCount: row.unknownCostInvocationCount,
      }),
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

  async summarizeModelCosts(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
    limit?: number;
  }): Promise<BudgetUsageModelSummary[]> {
    const safeLimit = Math.max(1, Math.min(input.limit ?? 5, 50));
    const rows = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(TRIM(model), ''), 'unknown') AS model,
                COALESCE(SUM(CASE WHEN cost_estimate IS NOT NULL THEN cost_estimate ELSE 0 END), 0) AS totalCostUsd,
                COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE 0 END), 0) AS totalInputTokens,
                COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE 0 END), 0) AS totalOutputTokens,
                COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS totalTokens,
                COUNT(*) AS invocationCount,
                SUM(CASE WHEN cost_estimate IS NOT NULL THEN 1 ELSE 0 END) AS knownCostInvocationCount,
                SUM(CASE WHEN cost_estimate IS NULL THEN 1 ELSE 0 END) AS unknownCostInvocationCount,
                SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS knownTokenInvocationCount,
                SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS unknownTokenInvocationCount
         FROM agent_invocations
         WHERE COALESCE(finished_at, created_at) >= @sinceIso
           AND COALESCE(finished_at, created_at) <= @untilIso
           AND (@profileId IS NULL OR COALESCE(profile_id, 'unassigned') = @profileId)
         GROUP BY COALESCE(NULLIF(TRIM(model), ''), 'unknown')
         ORDER BY totalTokens DESC, totalCostUsd DESC, invocationCount DESC, model ASC
         LIMIT @limit`,
      )
      .all({
        sinceIso: input.sinceIso,
        untilIso: input.untilIso,
        profileId: input.profileId ?? null,
        limit: safeLimit,
      }) as ModelCostAggregateRow[];
    return rows.map((row) => ({
      model: row.model,
      totalCostUsd: row.totalCostUsd,
      ...tokenUsageFields({
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalTokens: row.totalTokens,
        knownTokenInvocationCount: row.knownTokenInvocationCount,
        unknownTokenInvocationCount: row.unknownTokenInvocationCount,
      }),
      invocationCount: row.invocationCount,
      ...costCompletenessFields({
        knownCostInvocationCount: row.knownCostInvocationCount,
        unknownCostInvocationCount: row.unknownCostInvocationCount,
      }),
    }));
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
  if (row.cost === null) summary.costKnown = false;
  if (row.input_tokens !== null) summary.inputTokens = row.input_tokens;
  if (row.output_tokens !== null) summary.outputTokens = row.output_tokens;
  if (row.total_tokens !== null) summary.totalTokens = row.total_tokens;
  if (row.usage_approximate !== null) {
    summary.usageApproximate = row.usage_approximate === 1;
  }
  if (row.status === "succeeded") summary.success = true;
  if (row.status === "failed" || row.status === "cancelled") {
    summary.success = false;
  }
  return summary;
};

const normalizeModel = (model: string | null): string => {
  const trimmed = model?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "unknown";
};

const summarizePerModel = (
  invocations: TaskRunCostInvocationSummary[],
): TaskRunCostModelBreakdown[] => {
  const byModel = new Map<
    string,
    TaskRunCostModelBreakdown & {
      knownCostInvocationCount: number;
      unknownCostInvocationCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      knownTokenInvocationCount: number;
      unknownTokenInvocationCount: number;
    }
  >();
  for (const item of invocations) {
    const current = byModel.get(item.model) ?? {
      model: item.model,
      cost: 0,
      latencyMs: 0,
      count: 0,
      knownCostInvocationCount: 0,
      unknownCostInvocationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      knownTokenInvocationCount: 0,
      unknownTokenInvocationCount: 0,
    };
    const costKnown = item.costKnown !== false;
    const tokenKnown = item.totalTokens !== undefined;
    byModel.set(item.model, {
      model: item.model,
      cost: current.cost + item.cost,
      latencyMs: current.latencyMs + item.latencyMs,
      count: current.count + 1,
      knownCostInvocationCount:
        current.knownCostInvocationCount + (costKnown ? 1 : 0),
      unknownCostInvocationCount:
        current.unknownCostInvocationCount + (costKnown ? 0 : 1),
      inputTokens: current.inputTokens + (item.inputTokens ?? 0),
      outputTokens: current.outputTokens + (item.outputTokens ?? 0),
      totalTokens: current.totalTokens + (item.totalTokens ?? 0),
      knownTokenInvocationCount:
        current.knownTokenInvocationCount + (tokenKnown ? 1 : 0),
      unknownTokenInvocationCount:
        current.unknownTokenInvocationCount + (tokenKnown ? 0 : 1),
    });
  }
  const models: TaskRunCostModelBreakdown[] = [...byModel.values()]
    .map((item): TaskRunCostModelBreakdown => ({
      model: item.model,
      cost: item.cost,
      ...modelTokenUsageFields({
        totalInputTokens: item.inputTokens,
        totalOutputTokens: item.outputTokens,
        totalTokens: item.totalTokens,
        knownTokenInvocationCount: item.knownTokenInvocationCount,
        unknownTokenInvocationCount: item.unknownTokenInvocationCount,
      }),
      latencyMs: item.latencyMs,
      count: item.count,
      ...costCompletenessFields({
        knownCostInvocationCount: item.knownCostInvocationCount,
        unknownCostInvocationCount: item.unknownCostInvocationCount,
      }),
    }));
  return models.sort(
    (left, right) =>
      (right.totalTokens ?? 0) - (left.totalTokens ?? 0) ||
      right.cost - left.cost ||
      left.model.localeCompare(right.model),
  );
};

const summarizeTokenCompleteness = (
  invocations: TaskRunCostInvocationSummary[],
): TokenUsageFieldsInput => ({
  totalInputTokens: invocations.reduce(
    (sum, item) => sum + (item.inputTokens ?? 0),
    0,
  ),
  totalOutputTokens: invocations.reduce(
    (sum, item) => sum + (item.outputTokens ?? 0),
    0,
  ),
  totalTokens: invocations.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
  knownTokenInvocationCount: invocations.filter(
    (item) => item.totalTokens !== undefined,
  ).length,
  unknownTokenInvocationCount: invocations.filter(
    (item) => item.totalTokens === undefined,
  ).length,
});

interface TokenUsageFieldsInput {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  knownTokenInvocationCount: number;
  unknownTokenInvocationCount: number;
}

const tokenUsageFields = (
  input: TokenUsageFieldsInput,
):
  | {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      knownTokenInvocationCount?: number;
      unknownTokenInvocationCount?: number;
    }
  | Record<string, never> => {
  if (input.knownTokenInvocationCount <= 0) return {};
  return {
    totalInputTokens: input.totalInputTokens,
    totalOutputTokens: input.totalOutputTokens,
    totalTokens: input.totalTokens,
    ...(input.unknownTokenInvocationCount > 0
      ? {
          knownTokenInvocationCount: input.knownTokenInvocationCount,
          unknownTokenInvocationCount: input.unknownTokenInvocationCount,
        }
      : {}),
  };
};

const modelTokenUsageFields = (
  input: TokenUsageFieldsInput,
):
  | {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      knownTokenInvocationCount?: number;
      unknownTokenInvocationCount?: number;
    }
  | Record<string, never> => {
  if (input.knownTokenInvocationCount <= 0) return {};
  return {
    inputTokens: input.totalInputTokens,
    outputTokens: input.totalOutputTokens,
    totalTokens: input.totalTokens,
    ...(input.unknownTokenInvocationCount > 0
      ? {
          knownTokenInvocationCount: input.knownTokenInvocationCount,
          unknownTokenInvocationCount: input.unknownTokenInvocationCount,
        }
      : {}),
  };
};

const costCompletenessFields = (input: {
  knownCostInvocationCount: number;
  unknownCostInvocationCount: number;
}):
  | {
      knownCostInvocationCount: number;
      unknownCostInvocationCount: number;
    }
  | Record<string, never> =>
  input.unknownCostInvocationCount > 0
    ? {
        knownCostInvocationCount: input.knownCostInvocationCount,
        unknownCostInvocationCount: input.unknownCostInvocationCount,
      }
    : {};
