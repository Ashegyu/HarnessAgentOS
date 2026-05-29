import type {
  Capability,
  CreateCapabilityInput,
  SkillSource,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { loadSkills } from "./skill-loader.ts";
import type { SkillMetadata } from "./skill-metadata.ts";

/**
 * Phase 5 capability registry. Bridges SkillMetadata (filesystem) into
 * the capabilities table (DB) so the rest of the app can query without
 * touching skill directories directly.
 *
 * Phase 5 keeps the in-memory mirror cache so the UI does not have to
 * round-trip to disk for every suggestion.
 */
export interface SkillSourceConfig {
  /**
   * Logical source label, e.g. "skillify:project" or "skillify:user".
   * Used for prune-on-rescan so capabilities from a removed skill
   * directory go away even when the file is gone.
   */
  source: string;
  rootDir: string;
  trusted: boolean;
}

export interface CapabilityRegistryDeps {
  state: LocalStateService;
}

export interface CapabilityRefreshFailure {
  failedAt: string;
  message: string;
}

export class CapabilityRegistry {
  private readonly metadataCache = new Map<string, SkillMetadata>();
  private lastRefreshFailure: CapabilityRefreshFailure | null = null;
  private lastRefreshAt: string | null = null;

  private readonly deps: CapabilityRegistryDeps;
  constructor(deps: CapabilityRegistryDeps) {
    this.deps = deps;
  }

  /**
   * Load skills from the given trusted directories and upsert their
   * capabilities. Capabilities from each `source` that no longer match
   * an on-disk skill are removed so stale entries don't leak in.
   */
  async refresh(sources: SkillSourceConfig[]): Promise<Capability[]> {
    this.metadataCache.clear();
    const upserted: Capability[] = [];
    try {
      for (const src of sources) {
        const metas = await loadSkills({
          rootDir: src.rootDir,
          trusted: src.trusted,
        });
        const ids: string[] = [];
        for (const meta of metas) {
          this.metadataCache.set(meta.id, meta);
          const input: CreateCapabilityInput = {
            id: meta.id,
            source: src.source,
            name: meta.name,
            description: meta.description,
            triggerTerms: meta.triggerTerms,
            riskLevel: meta.riskLevel,
            requiresApproval: requiresApprovalFor(meta),
          };
          const cap = await this.deps.state.upsertCapability(input);
          upserted.push(cap);
          ids.push(cap.id);
        }
        await this.deps.state.pruneCapabilities(src.source, ids);
      }
      this.lastRefreshAt = new Date().toISOString();
      this.lastRefreshFailure = null;
      return upserted;
    } catch (error) {
      this.recordRefreshFailure(error);
      throw error;
    }
  }

  async refreshPersistedSources(): Promise<Capability[]> {
    try {
      const rows = await this.deps.state.skillSources.list();
      const enabled = rows.filter((row) => row.enabled);
      const upserted = await this.refresh(
        enabled.map(skillSourceConfigFromSource),
      );
      for (const disabled of rows.filter((row) => !row.enabled)) {
        await this.deps.state.pruneCapabilities(
          skillSourceConfigFromSource(disabled).source,
          [],
        );
      }
      return upserted;
    } catch (error) {
      this.recordRefreshFailure(error);
      throw error;
    }
  }

  recordRefreshFailure(error: unknown): void {
    this.lastRefreshFailure = {
      failedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  getLastRefreshFailure(): CapabilityRefreshFailure | null {
    return this.lastRefreshFailure;
  }

  getLastRefreshAt(): string | null {
    return this.lastRefreshAt;
  }

  async list(): Promise<Capability[]> {
    return this.deps.state.listCapabilities();
  }

  getMetadata(id: string): SkillMetadata | undefined {
    return this.metadataCache.get(id);
  }
}

export const skillSourceConfigFromSource = (
  source: SkillSource,
): SkillSourceConfig => ({
  source:
    source.origin === "project"
      ? "skillify:project"
      : source.origin === "user"
        ? "skillify:user"
        : `skillify:${source.id}`,
  rootDir: source.rootDir,
  trusted: source.trusted,
});

const requiresApprovalFor = (meta: SkillMetadata): boolean => {
  // Anything that proposes side-effecting actions, or is untrusted, must
  // pass through the approval flow before a script run is permitted.
  if (!meta.trusted) return true;
  if (meta.riskLevel === "high" || meta.riskLevel === "medium") return true;
  if (meta.allowedActions.length > 0) return true;
  return false;
};
