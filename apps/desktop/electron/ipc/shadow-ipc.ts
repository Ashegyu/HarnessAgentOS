import {
  RUNNER_EXECUTION_FAILED,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessResult,
  type ShadowPreview,
} from "@harness/core";
import {
  ShadowWorkspaceError,
  type ShadowWorkspaceService,
} from "@harness/runners";

export interface ShadowIpcContext {
  shadow: ShadowWorkspaceService;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const wrapErr = <T>(e: unknown): HarnessResult<T> => {
  if (e instanceof ShadowWorkspaceError) {
    return err(harnessError(e.code, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  return err(harnessError(RUNNER_EXECUTION_FAILED, msg));
};

export const buildShadowHandlers = (ctx: ShadowIpcContext) => ({
  createPreview: async (
    input: unknown,
  ): Promise<HarnessResult<ShadowPreview>> => {
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
      return ok(await ctx.shadow.createPreview({ approvalId: cast.approvalId }));
    } catch (e) {
      return wrapErr<ShadowPreview>(e);
    }
  },
});

export type ShadowIpcHandlers = ReturnType<typeof buildShadowHandlers>;
