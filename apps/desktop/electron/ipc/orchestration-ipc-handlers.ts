import {
  ORCHESTRATION_INVALID_PLAN,
  ORCHESTRATION_PLAN_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type Approval,
  type Artifact,
  type HarnessResult,
  type OrchestrationMode,
  type OrchestrationPlan,
  type OrchestrationRunResult,
} from "@harness/core";
import {
  ORCHESTRATION_MODES,
  OrchestrationError,
  type OrchestrationService,
} from "@harness/orchestration";
import type { HarnessEventBus } from "../event-bus";

type OrchestrationIpcService = Pick<
  OrchestrationService,
  "isEnabled" | "getLatestPlan" | "draftPlan" | "runApproved"
>;

export interface OrchestrationIpcContext {
  service: OrchestrationIpcService;
  events: Pick<HarnessEventBus, "taskRunChanged">;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(
  e: unknown,
  code = ORCHESTRATION_PLAN_NOT_FOUND,
): HarnessResult<T> => {
  if (e instanceof OrchestrationError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(code, msg));
};

const isOrchestrationMode = (v: unknown): v is OrchestrationMode =>
  typeof v === "string" &&
  (ORCHESTRATION_MODES as readonly string[]).includes(v);

const parseHarnessSource = (
  input: unknown,
):
  | {
      ok: true;
      value?: { packageId: string; workflowId?: string; bindingSetId: string };
    }
  | { ok: false; reason: string } => {
  if (input === undefined || input === null) return { ok: true };
  if (!isObject(input)) return { ok: false, reason: "harness must be an object" };
  if (!isNonEmptyString(input.packageId)) {
    return {
      ok: false,
      reason: "harness.packageId must be non-empty string",
    };
  }
  if (!isNonEmptyString(input.bindingSetId)) {
    return {
      ok: false,
      reason: "harness.bindingSetId must be non-empty string",
    };
  }
  if (input.workflowId !== undefined && !isNonEmptyString(input.workflowId)) {
    return {
      ok: false,
      reason: "harness.workflowId must be non-empty string when provided",
    };
  }
  return {
    ok: true,
    value: {
      packageId: input.packageId.trim(),
      bindingSetId: input.bindingSetId.trim(),
      ...(typeof input.workflowId === "string"
        ? { workflowId: input.workflowId.trim() }
        : {}),
    },
  };
};

export const buildOrchestrationHandlers = (ctx: OrchestrationIpcContext) => ({
  getPlan: async (
    input: unknown,
  ): Promise<HarnessResult<OrchestrationPlan | null>> => {
    if (!isObject(input)) {
      return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
    }
    const cast = input as { taskRunId?: unknown };
    if (!isNonEmptyString(cast.taskRunId)) {
      return err(
        harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
      );
    }
    try {
      if (!ctx.service.isEnabled()) return ok(null);
      return ok(await ctx.service.getLatestPlan({ taskRunId: cast.taskRunId }));
    } catch (e) {
      return wrapErr<OrchestrationPlan | null>(e);
    }
  },

  draftPlan: async (
    input: unknown,
  ): Promise<
    HarnessResult<{
      plan: OrchestrationPlan;
      artifact: Artifact;
      approval: Approval;
    }>
  > => {
    if (!isObject(input)) {
      return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
    }
    const cast = input as {
      taskRunId?: unknown;
      mode?: unknown;
      instruction?: unknown;
      pipelineId?: unknown;
      harness?: unknown;
    };
    if (!isNonEmptyString(cast.taskRunId)) {
      return err(
        harnessError(STATE_INVALID_INPUT, "taskRunId must be non-empty string"),
      );
    }
    if (!isOrchestrationMode(cast.mode)) {
      return err(
        harnessError(ORCHESTRATION_INVALID_PLAN, "Unknown orchestration mode"),
      );
    }
    const payload: Parameters<OrchestrationIpcService["draftPlan"]>[0] = {
      taskRunId: cast.taskRunId,
      mode: cast.mode,
    };
    if (typeof cast.instruction === "string") {
      payload.instruction = cast.instruction;
    }
    if (typeof cast.pipelineId === "string" && cast.pipelineId.length > 0) {
      payload.pipelineId = cast.pipelineId;
    }
    const harness = parseHarnessSource(cast.harness);
    if (!harness.ok) {
      return err(harnessError(STATE_INVALID_INPUT, harness.reason));
    }
    if (payload.pipelineId && harness.value) {
      return err(
        harnessError(
          ORCHESTRATION_INVALID_PLAN,
          "pipelineId and harness cannot both be provided",
        ),
      );
    }
    if (harness.value) payload.harness = harness.value;
    try {
      const drafted = await ctx.service.draftPlan(payload);
      ctx.events.taskRunChanged(drafted.plan.taskRunId);
      return ok(drafted);
    } catch (e) {
      return wrapErr<{
        plan: OrchestrationPlan;
        artifact: Artifact;
        approval: Approval;
      }>(e);
    }
  },

  runApproved: async (
    input: unknown,
  ): Promise<HarnessResult<OrchestrationRunResult>> => {
    if (!isObject(input)) {
      return err(harnessError(STATE_INVALID_INPUT, "input must be an object"));
    }
    const cast = input as { approvalId?: unknown };
    if (!isNonEmptyString(cast.approvalId)) {
      return err(
        harnessError(STATE_INVALID_INPUT, "approvalId must be non-empty string"),
      );
    }
    try {
      const result = await ctx.service.runApproved({
        approvalId: cast.approvalId,
      });
      ctx.events.taskRunChanged(result.taskRunId);
      return ok(result);
    } catch (e) {
      return wrapErr<OrchestrationRunResult>(e);
    }
  },
});

export type OrchestrationIpcHandlers = ReturnType<
  typeof buildOrchestrationHandlers
>;
