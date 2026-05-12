import {
  SKILL_SOURCE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  isSkillSource,
  ok,
  type HarnessResult,
  type SkillSource,
} from "@harness/core";
import type { SkillSourceRepository } from "@harness/storage";

/**
 * The path-policy registry exposes a tiny "register/unregister" surface
 * so the IPC handler can keep `sourceDir` whitelist in sync with custom
 * skill roots without the handler importing the policy module directly.
 */
export interface SkillRootPolicy {
  registerSourceDir(rootDir: string): void;
  unregisterSourceDir(rootDir: string): void;
}

/**
 * Capability registry abstraction — just enough surface for `refresh`.
 * Phase 4 will wire this to the real `CapabilityRegistry` instance.
 */
export interface CapabilityRefreshable {
  refresh(): Promise<{ skillCount: number }>;
}

export interface SkillSourceIpcContext {
  skillSources: SkillSourceRepository;
  pathPolicy: SkillRootPolicy;
  capabilityRegistry: CapabilityRefreshable;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

export const buildSkillSourceHandlers = (ctx: SkillSourceIpcContext) => {
  const { skillSources, pathPolicy, capabilityRegistry } = ctx;

  return {
    list: async (): Promise<HarnessResult<SkillSource[]>> =>
      wrap(() => skillSources.list()),

    add: async (input: {
      name: string;
      rootDir: string;
    }): Promise<HarnessResult<SkillSource>> => {
      if (typeof input?.name !== "string" || input.name.trim().length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "name must be non-empty"));
      }
      if (typeof input?.rootDir !== "string" || input.rootDir.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "rootDir must be non-empty"));
      }
      return wrap(async () => {
        const added = await skillSources.add({
          name: input.name.trim(),
          rootDir: input.rootDir,
        });
        // Sync with path-policy registry so a fresh invocation immediately
        // sees the new root without a restart.
        pathPolicy.registerSourceDir(added.rootDir);
        // Stamp the row so the UI badge reflects the policy state.
        return skillSources.update({
          ...added,
          registeredInPathPolicy: true,
        });
      });
    },

    update: async (input: {
      source: unknown;
    }): Promise<HarnessResult<SkillSource>> => {
      const candidate = input?.source;
      if (!isSkillSource(candidate)) {
        return err(
          harnessError(
            STATE_INVALID_INPUT,
            "source failed SkillSource validation",
          ),
        );
      }
      const source: SkillSource = candidate;
      const existing = await skillSources.get(source.id);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${source.id}`),
        );
      }
      return wrap(() => skillSources.update(source));
    },

    remove: async (input: {
      sourceId: string;
    }): Promise<HarnessResult<void>> => {
      if (typeof input?.sourceId !== "string" || input.sourceId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "sourceId is required"));
      }
      const existing = await skillSources.get(input.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${input.sourceId}`),
        );
      }
      return wrap(async () => {
        await skillSources.remove(input.sourceId);
        pathPolicy.unregisterSourceDir(existing.rootDir);
      });
    },

    refresh: async (input: {
      sourceId: string;
    }): Promise<HarnessResult<{ skillCount: number }>> => {
      if (typeof input?.sourceId !== "string" || input.sourceId.length === 0) {
        return err(harnessError(STATE_INVALID_INPUT, "sourceId is required"));
      }
      const existing = await skillSources.get(input.sourceId);
      if (!existing) {
        return err(
          harnessError(SKILL_SOURCE_NOT_FOUND, `unknown source: ${input.sourceId}`),
        );
      }
      return wrap(() => capabilityRegistry.refresh());
    },
  };
};

export type SkillSourceIpcHandlers = ReturnType<typeof buildSkillSourceHandlers>;
