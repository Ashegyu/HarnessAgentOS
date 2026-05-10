import type { Capability, CreateCapabilityInput } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { loadSkills } from "./skill-loader";
import type { SkillMetadata } from "./skill-metadata";

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

export class CapabilityRegistry {
  private readonly metadataCache = new Map<string, SkillMetadata>();

  constructor(private readonly deps: CapabilityRegistryDeps) {}

  /**
   * Load skills from the given trusted directories and upsert their
   * capabilities. Capabilities from each `source` that no longer match
   * an on-disk skill are removed so stale entries don't leak in.
   */
  async refresh(sources: SkillSourceConfig[]): Promise<Capability[]> {
    this.metadataCache.clear();
    const upserted: Capability[] = [];
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
    return upserted;
  }

  async list(): Promise<Capability[]> {
    return this.deps.state.listCapabilities();
  }

  getMetadata(id: string): SkillMetadata | undefined {
    return this.metadataCache.get(id);
  }
}

const requiresApprovalFor = (meta: SkillMetadata): boolean => {
  // Anything that proposes side-effecting actions, or is untrusted, must
  // pass through the approval flow before a script run is permitted.
  if (!meta.trusted) return true;
  if (meta.riskLevel === "high" || meta.riskLevel === "medium") return true;
  if (meta.allowedActions.length > 0) return true;
  return false;
};
