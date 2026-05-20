import {
  PIPELINE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isAgentPipelineBackflowRule,
  isAgentPipelineStep,
  ok,
  type AgentPipeline,
  type CreateAgentPipelineInput,
  type HarnessResult,
} from "@harness/core";
import type { AgentPipelineRepository } from "@harness/storage";

export interface PipelineIpcContext {
  pipelines: AgentPipelineRepository;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

const validateCreateInput = (
  raw: unknown,
):
  | { ok: true; value: CreateAgentPipelineInput }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "pipeline must be an object" };
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim().length === 0) {
    return { ok: false, reason: "name must be a non-empty string" };
  }
  if (typeof p.description !== "string") {
    return { ok: false, reason: "description must be a string" };
  }
  if (!Array.isArray(p.steps)) {
    return { ok: false, reason: "steps must be an array" };
  }
  if (p.steps.length < 1) {
    return { ok: false, reason: "steps must contain at least one step" };
  }
  for (const [i, step] of p.steps.entries()) {
    if (!isAgentPipelineStep(step)) {
      return { ok: false, reason: `steps[${i}] is malformed` };
    }
  }
  if (p.backflowRules !== undefined) {
    if (!Array.isArray(p.backflowRules)) {
      return { ok: false, reason: "backflowRules must be an array" };
    }
    for (const [i, rule] of p.backflowRules.entries()) {
      if (!isAgentPipelineBackflowRule(rule)) {
        return { ok: false, reason: `backflowRules[${i}] is malformed` };
      }
    }
  }
  return { ok: true, value: raw as CreateAgentPipelineInput };
};

const validateUpdateInput = (
  raw: unknown,
): { ok: true; value: AgentPipeline } | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "pipeline must be an object" };
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0) {
    return { ok: false, reason: "id is required for update" };
  }
  const v = validateCreateInput(raw);
  if (!v.ok) return v;
  return { ok: true, value: raw as AgentPipeline };
};

/**
 * Pure handler factory — no electron import. Tests use it directly.
 */
export const buildPipelineHandlers = (ctx: PipelineIpcContext) => {
  const { pipelines } = ctx;
  return {
    list: async (): Promise<HarnessResult<AgentPipeline[]>> =>
      wrap(() => pipelines.list()),

    get: async (input: {
      pipelineId: string;
    }): Promise<HarnessResult<AgentPipeline>> => {
      if (
        typeof input?.pipelineId !== "string" ||
        input.pipelineId.length === 0
      ) {
        return err(
          harnessError(STATE_INVALID_INPUT, "pipelineId is required"),
        );
      }
      const found = await pipelines.get(input.pipelineId);
      if (!found) {
        return err(
          harnessError(
            PIPELINE_NOT_FOUND,
            `unknown pipeline: ${input.pipelineId}`,
          ),
        );
      }
      return ok(found);
    },

    create: async (input: {
      pipeline: unknown;
    }): Promise<HarnessResult<AgentPipeline>> => {
      const v = validateCreateInput(input?.pipeline);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(() => pipelines.create(v.value));
    },

    update: async (input: {
      pipeline: unknown;
    }): Promise<HarnessResult<AgentPipeline>> => {
      const v = validateUpdateInput(input?.pipeline);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      const existing = await pipelines.get(v.value.id);
      if (!existing) {
        return err(
          harnessError(
            PIPELINE_NOT_FOUND,
            `cannot update unknown pipeline: ${v.value.id}`,
          ),
        );
      }
      return wrap(() => pipelines.update(v.value));
    },

    delete: async (input: {
      pipelineId: string;
    }): Promise<HarnessResult<void>> => {
      if (
        typeof input?.pipelineId !== "string" ||
        input.pipelineId.length === 0
      ) {
        return err(
          harnessError(STATE_INVALID_INPUT, "pipelineId is required"),
        );
      }
      return wrap(async () => {
        await pipelines.delete(input.pipelineId);
      });
    },
  };
};

export type PipelineIpcHandlers = ReturnType<typeof buildPipelineHandlers>;
