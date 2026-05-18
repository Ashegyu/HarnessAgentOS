import type { SkillSource, SkillSourceRefreshResult } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import {
  loadSkills,
  type CapabilityRegistry,
  type SkillSourceConfig,
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
  const rows = await ctx.state.skillSources.list();
  const enabled = rows.filter((row) => row.enabled);
  const configs = enabled.map(skillSourceConfigFromRow);
  const scanned = source.enabled
    ? await loadSkills({
        rootDir: source.rootDir,
        trusted: source.trusted,
      })
    : [];
  const caps = await ctx.capabilityRegistry.refresh(configs);
  for (const disabled of rows.filter((row) => !row.enabled)) {
    await ctx.state.pruneCapabilities(
      skillSourceConfigFromRow(disabled).source,
      [],
    );
  }
  const sourceKey = skillSourceConfigFromRow(source).source;
  return {
    sourceId: source.id,
    scannedCount: scanned.length,
    updatedCount: caps.filter((cap) => cap.source === sourceKey).length,
    skillCount: caps.length,
  };
};

export const skillSourceConfigFromRow = (
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
