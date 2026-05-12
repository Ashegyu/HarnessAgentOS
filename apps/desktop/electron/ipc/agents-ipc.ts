import {
  AGENT_PROFILE_NOT_FOUND,
  PIPELINE_IN_USE_BY_PROFILE_DELETE,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isAgentProfile,
  ok,
  type AgentProfile,
  type HarnessResult,
  type HarnessSettings,
} from "@harness/core";
import type {
  AgentPipelineRepository,
  AgentProfileRepository,
  CreateAgentProfileInput,
} from "@harness/storage";

/**
 * Anything the handler suite needs to perform its work. Kept thin so
 * tests can hand-roll a context without spinning up Electron.
 */
export interface AgentsIpcState {
  readonly profiles: AgentProfileRepository;
  /**
   * Optional — when present, `delete` performs a reverse-reference check
   * against pipelines and rejects with PIPELINE_IN_USE_BY_PROFILE_DELETE
   * if any pipeline still references the profile being removed. Kept
   * optional so legacy callers / tests that don't care about pipelines
   * can omit it without scaffolding.
   */
  readonly pipelines?: AgentPipelineRepository;
  getSettings(): Promise<HarnessSettings>;
  updateSettings(input: HarnessSettings): Promise<HarnessSettings>;
}

export interface AgentsIpcContext {
  state: AgentsIpcState;
}

const validateCreateInput = (
  raw: unknown,
):
  | { ok: true; value: CreateAgentProfileInput }
  | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "profile must be an object" };
  }
  // Stamp throwaway id/timestamps so the shared type guard from @harness/core
  // can run without duplicating its rules here. The repository assigns the
  // real id + timestamps on insert.
  const stamped = {
    id: "ap_placeholder",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...(raw as Record<string, unknown>),
  };
  if (!isAgentProfile(stamped)) {
    return { ok: false, reason: "profile failed AgentProfile validation" };
  }
  const profile = raw as CreateAgentProfileInput;
  if (profile.name.trim().length === 0) {
    return { ok: false, reason: "name must be non-empty" };
  }
  return { ok: true, value: profile };
};

const validateProfile = (
  raw: unknown,
): { ok: true; value: AgentProfile } | { ok: false; reason: string } => {
  if (!isAgentProfile(raw)) {
    return { ok: false, reason: "profile failed AgentProfile validation" };
  }
  return { ok: true, value: raw };
};

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

/**
 * Pure handler factory — tests use this directly. The Electron-bound
 * wiring lives in `agents-ipc-register.ts` so this module stays free of
 * electron imports and remains testable under plain Node.
 */
export const buildAgentsHandlers = (ctx: AgentsIpcContext) => {
  const { state } = ctx;
  return {
    list: async (): Promise<HarnessResult<AgentProfile[]>> =>
      wrap(() => state.profiles.list()),

    get: async (input: {
      profileId: string;
    }): Promise<HarnessResult<AgentProfile>> => {
      if (typeof input?.profileId !== "string" || input.profileId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "profileId is required"));
      }
      const found = await state.profiles.get(input.profileId);
      if (!found) {
        return err(
          harnessError(AGENT_PROFILE_NOT_FOUND, `unknown profile: ${input.profileId}`),
        );
      }
      return ok(found);
    },

    create: async (input: {
      profile: unknown;
    }): Promise<HarnessResult<AgentProfile>> => {
      const v = validateCreateInput(input?.profile);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      return wrap(() => state.profiles.create(v.value));
    },

    update: async (input: {
      profile: unknown;
    }): Promise<HarnessResult<AgentProfile>> => {
      const v = validateProfile(input?.profile);
      if (!v.ok) return err(harnessError(STATE_INVALID_INPUT, v.reason));
      const existing = await state.profiles.get(v.value.id);
      if (!existing) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `cannot update unknown profile: ${v.value.id}`,
          ),
        );
      }
      return wrap(() => state.profiles.update(v.value));
    },

    delete: async (input: {
      profileId: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.profileId !== "string" || input.profileId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "profileId is required"));
      }
      if (state.pipelines) {
        const refs = await state.pipelines.findByReferencedAgentProfileId(
          input.profileId,
        );
        if (refs.length > 0) {
          const names = refs.map((p) => p.name).join(", ");
          return err(
            harnessError(
              PIPELINE_IN_USE_BY_PROFILE_DELETE,
              `Profile is referenced by pipeline(s): ${names}. Remove the pipeline(s) or replace the profile reference first.`,
              { pipelineIds: refs.map((p) => p.id) },
            ),
          );
        }
      }
      return wrap(async () => {
        await state.profiles.delete(input.profileId);
      });
    },

    setDefault: async (input: {
      profileId: string;
    }): Promise<HarnessResult<AgentProfile>> => {
      if (typeof input?.profileId !== "string" || input.profileId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "profileId is required"));
      }
      const existing = await state.profiles.get(input.profileId);
      if (!existing) {
        return err(
          harnessError(
            AGENT_PROFILE_NOT_FOUND,
            `unknown profile: ${input.profileId}`,
          ),
        );
      }
      return wrap(() => state.profiles.setDefault(input.profileId));
    },

    /**
     * Sets HarnessSettings.activeAgentProfileId. `null` clears the
     * field so the resolver falls back to the isDefault row.
     */
    setActive: async (input: {
      profileId: string | null;
    }): Promise<HarnessResult<HarnessSettings>> => {
      if (input?.profileId !== null && typeof input?.profileId !== "string") {
        return err(
          harnessError(STATE_INVALID_INPUT, "profileId must be string or null"),
        );
      }
      if (input.profileId !== null) {
        const existing = await state.profiles.get(input.profileId);
        if (!existing) {
          return err(
            harnessError(
              AGENT_PROFILE_NOT_FOUND,
              `unknown profile: ${input.profileId}`,
            ),
          );
        }
      }
      return wrap(async () => {
        const current = await state.getSettings();
        const next: HarnessSettings = { ...current };
        if (input.profileId === null) {
          delete next.activeAgentProfileId;
        } else {
          next.activeAgentProfileId = input.profileId;
        }
        return state.updateSettings(next);
      });
    },
  };
};

export type AgentsIpcHandlers = ReturnType<typeof buildAgentsHandlers>;
