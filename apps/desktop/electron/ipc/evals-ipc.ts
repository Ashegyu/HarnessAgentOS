import {
  EVAL_RUN_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type EvalRunDetailView,
  type EvalRunListFilters,
  type EvalRunListItem,
  type HarnessResult,
} from "@harness/core";
import type { EvalRunRepository } from "@harness/storage";
import {
  evalRunRecordToDetail,
  evalRunRecordToListItem,
} from "@harness/evals";

export interface EvalsIpcContext {
  evalRuns: Pick<EvalRunRepository, "list" | "get">;
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

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type EvalsIpcHandlers = ReturnType<typeof buildEvalsHandlers>;
