import type { SkillSource, SkillSourceRefreshResult } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import {
  loadSkills,
  type CapabilityRegistry,
  skillSourceConfigFromSource,
} from "@harness/skillify-adapter";

export interface SkillSourceRefreshContext {
  state: LocalStateService;
  capabilityRegistry: CapabilityRegistry;
}

export const refreshGeneratedSkillSourceAfterRunner = async (
  ctx: SkillSourceRefreshContext,
  approvalId: string,
): Promise<void> => {
  const approval = await ctx.state.getApproval(approvalId);
  if (
    !approval ||
    approval.actionType !== "file_write" ||
    approval.proposedAction?.type !== "file_write" ||
    !approval.proposedAction.filePatch
  ) {
    return;
  }

  const checkpoints = await ctx.state.listCheckpointsByTaskRun(
    approval.taskRunId,
  );
  const checkpoint = checkpoints.find((item) => item.id === approval.checkpointId);
  const stateRef = parseStateRef(checkpoint?.stateRef);
  if (
    typeof stateRef.sourceId !== "string" ||
    typeof stateRef.relativePath !== "string" ||
    typeof stateRef.skillSlug !== "string"
  ) {
    return;
  }
  if (approval.proposedAction.filePatch.path !== stateRef.relativePath) {
    return;
  }

  const source = await ctx.state.skillSources.get(stateRef.sourceId);
  if (!source) return;
  await refreshSkillSourceCapabilities(ctx, source);
};

export const refreshSkillSourceCapabilities = async (
  ctx: SkillSourceRefreshContext,
  source: SkillSource,
): Promise<SkillSourceRefreshResult> => {
  // Rebuild from persisted rows so custom sources added in Settings
  // participate in refresh without requiring a restart.
  try {
    const scanned = source.enabled
      ? await loadSkills({
          rootDir: source.rootDir,
          trusted: source.trusted,
        })
      : [];
    const caps = await ctx.capabilityRegistry.refreshPersistedSources();
    const sourceKey = skillSourceConfigFromSource(source).source;
    return {
      sourceId: source.id,
      scannedCount: scanned.length,
      updatedCount: caps.filter((cap) => cap.source === sourceKey).length,
      skillCount: caps.length,
    };
  } catch (error) {
    ctx.capabilityRegistry.recordRefreshFailure(error);
    throw error;
  }
};

const parseStateRef = (raw: string | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
