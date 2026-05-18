import {
  EVAL_RUN_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type EvalCostTrendFilters,
  type EvalCostTrendView,
  type EvalRunDetailView,
  type EvalRunListFilters,
  type EvalRunListItem,
  type HarnessResult,
  type RuntimeLatencyFilters,
  type RuntimeLatencySummary,
} from "@harness/core";
import type {
  AgentInvocationRepository,
  EvalRunRepository,
} from "@harness/storage";
import {
  computeEvalCostTrend,
  computeRuntimeLatencySummaries,
  evalRunRecordToDetail,
  evalRunRecordToListItem,
} from "@harness/evals";

export interface EvalsIpcContext {
  evalRuns: Pick<EvalRunRepository, "list" | "get">;
  agentInvocations: Pick<AgentInvocationRepository, "listRecentWithLatency">;
}

const VALID_SUITES = new Set(["capability", "regression", "safety", "all"]);
const VALID_STATUSES = new Set(["running", "passed", "failed", "partial"]);

export const buildEvalsHandlers = (ctx: EvalsIpcContext) => ({
  listRuns: async (
    input: EvalRunListFilters = {},
  ): Promise<HarnessResult<EvalRunListItem[]>> => {
    const filters = validateListFilters(input);
    if (!filters.ok) {
      return err(harnessError(STATE_INVALID_INPUT, filters.reason));
    }
    try {
      const runs = await ctx.evalRuns.list(filters.value);
      return ok(runs.map(evalRunRecordToListItem));
    } catch (error) {
      return err(harnessError(STATE_INVALID_INPUT, message(error)));
    }
  },

  getRun: async (input: {
    runId: string;
  }): Promise<HarnessResult<EvalRunDetailView>> => {
    if (typeof input?.runId !== "string" || input.runId.length === 0) {
      return err(harnessError(STATE_INVALID_INPUT, "runId is required"));
    }
    try {
      const run = await ctx.evalRuns.get(input.runId);
      if (!run) {
        return err(
          harnessError(EVAL_RUN_NOT_FOUND, `unknown eval run: ${input.runId}`),
        );
      }
      return ok(evalRunRecordToDetail(run));
    } catch (error) {
      return err(harnessError(STATE_INVALID_INPUT, message(error)));
    }
  },

  getCostTrend: async (
    input: EvalCostTrendFilters = {},
  ): Promise<HarnessResult<EvalCostTrendView>> => {
    const filters = validateTrendFilters(input);
    if (!filters.ok) {
      return err(harnessError(STATE_INVALID_INPUT, filters.reason));
    }
    try {
      const runs = await ctx.evalRuns.list({
        ...(filters.value.suite ? { suite: filters.value.suite } : {}),
        limit: filters.value.limit,
      });
      return ok(
        computeEvalCostTrend(runs, {
          baselineWindow: filters.value.baselineWindow,
        }),
      );
    } catch (error) {
      return err(harnessError(STATE_INVALID_INPUT, message(error)));
    }
  },

  getRuntimeLatencySummary: async (
    input: RuntimeLatencyFilters = {},
  ): Promise<HarnessResult<RuntimeLatencySummary[]>> => {
    const filters = validateLatencyFilters(input);
    if (!filters.ok) {
      return err(harnessError(STATE_INVALID_INPUT, filters.reason));
    }
    try {
      const invocations = await ctx.agentInvocations.listRecentWithLatency(
        filters.value.limit,
      );
      return ok(
        computeRuntimeLatencySummaries(
          invocations
            .filter((invocation) => typeof invocation.latencyMs === "number")
            .map((invocation) => ({
              kind: "agent_invocation_to_final_result",
              durationMs: invocation.latencyMs ?? 0,
              success: invocation.status === "succeeded",
            })),
        ),
      );
    } catch (error) {
      return err(harnessError(STATE_INVALID_INPUT, message(error)));
    }
  },
});

const validateListFilters = (
  input: EvalRunListFilters,
):
  | { ok: true; value: EvalRunListFilters }
  | { ok: false; reason: string } => {
  const value: {
    suite?: EvalRunListFilters["suite"];
    status?: EvalRunListFilters["status"];
    limit?: number;
  } = {};
  if (input.suite !== undefined) {
    if (!VALID_SUITES.has(input.suite)) {
      return { ok: false, reason: "suite is invalid" };
    }
    value.suite = input.suite;
  }
  if (input.status !== undefined) {
    if (!VALID_STATUSES.has(input.status)) {
      return { ok: false, reason: "status is invalid" };
    }
    value.status = input.status;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      return { ok: false, reason: "limit must be an integer between 1 and 100" };
    }
    value.limit = input.limit;
  }
  return { ok: true, value };
};

const validateTrendFilters = (
  input: EvalCostTrendFilters,
):
  | { ok: true; value: EvalCostTrendFilters }
  | { ok: false; reason: string } => {
  const value: {
    suite?: EvalCostTrendFilters["suite"];
    limit?: number;
    baselineWindow?: number;
  } = {};
  if (input.suite !== undefined) {
    if (!VALID_SUITES.has(input.suite)) {
      return { ok: false, reason: "suite is invalid" };
    }
    value.suite = input.suite;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      return { ok: false, reason: "limit must be an integer between 1 and 100" };
    }
    value.limit = input.limit;
  } else {
    value.limit = 50;
  }
  if (input.baselineWindow !== undefined) {
    if (
      !Number.isInteger(input.baselineWindow) ||
      input.baselineWindow < 1 ||
      input.baselineWindow > 20
    ) {
      return {
        ok: false,
        reason: "baselineWindow must be an integer between 1 and 20",
      };
    }
    value.baselineWindow = input.baselineWindow;
  }
  return { ok: true, value };
};

const validateLatencyFilters = (
  input: RuntimeLatencyFilters,
):
  | { ok: true; value: Required<RuntimeLatencyFilters> }
  | { ok: false; reason: string } => {
  const limit = input.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, reason: "limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: { limit } };
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type EvalsIpcHandlers = ReturnType<typeof buildEvalsHandlers>;
