import type {
  Artifact,
  CapabilityPromptContext,
  ContextPack,
  ContextPackPinnedObservationOutcome,
  ContextPackSection,
  ContextPackSource,
  ContextPackSourceKind,
  Instinct,
  ObservationRecallResult,
  QualityGateResult,
  TaskRun,
} from "@harness/core";
import type { PackedRepoContext } from "./context-packer.ts";
import type { ThreadContextPromptTask } from "./agent-prompt-builder.ts";

export interface BuildContextPackInput {
  taskRun: TaskRun;
  profileId?: string | null;
  profileName?: string | null;
  qualityRisks?: QualityGateResult | null;
  instinctContexts?: readonly Instinct[];
  capabilityContexts?: readonly CapabilityPromptContext[];
  threadContext?: readonly ThreadContextPromptTask[];
  recentArtifacts?: readonly Artifact[];
  repoContext?: PackedRepoContext | string | null;
  pinnedObservationContexts?: readonly ObservationRecallResult[];
}

export const buildContextPack = (input: BuildContextPackInput): ContextPack => {
  const instincts = input.instinctContexts ?? [];
  const capabilities = input.capabilityContexts ?? [];
  const threadTasks = input.threadContext ?? [];
  const artifacts = input.recentArtifacts ?? [];
  const repoFiles = repoContextFiles(input.repoContext);
  const pinnedObservations = (input.pinnedObservationContexts ?? []).slice(0, 5);
  const pinnedObservationOutcomes = pinnedObservations
    .map(compactPinnedObservationOutcome)
    .filter(
      (
        outcome,
      ): outcome is ContextPackPinnedObservationOutcome => outcome !== null,
    );
  const qualityRiskCount = input.qualityRisks?.knownRisks.length ?? 0;

  const sources: ContextPackSource[] = [
    ...instincts.map((instinct): ContextPackSource => ({
      kind: "instinct",
      id: instinct.id,
      title: instinct.title,
      reason: `confidence ${Math.round(instinct.confidence * 100)}%`,
    })),
    ...capabilities.map((ctx): ContextPackSource => ({
      kind: "capability",
      id: ctx.capability.id,
      title: ctx.capability.name,
      reason: ctx.reason,
    })),
    ...(input.qualityRisks
      ? [
          {
            kind: "quality_gate" as const,
            id: input.qualityRisks.id,
            title: `quality gate ${input.qualityRisks.status}`,
            reason: input.qualityRisks.knownRisks.slice(0, 3).join("; "),
          },
        ]
      : []),
    ...threadTasks.map((task): ContextPackSource => ({
      kind: "thread_task",
      id: task.taskRunId,
      title: `Task ${task.ordinal}`,
      reason: task.answerSummary?.slice(0, 160) ?? task.status,
    })),
    ...artifacts.slice(0, 6).map((artifact): ContextPackSource => ({
      kind: "artifact",
      id: artifact.id,
      title: artifact.title,
      reason: artifact.kind,
    })),
    ...repoFiles.map((file): ContextPackSource => ({
      kind: "repo_context",
      id: file,
      title: file,
    })),
    ...pinnedObservations.map((context): ContextPackSource => ({
      kind: "pinned_observation",
      id: context.observationId,
      title: `${context.source}:${context.signal}`,
      reason: context.summary.slice(0, 160),
    })),
  ];

  const sections: ContextPackSection[] = [
    section("Active Instincts", instincts.map((instinct) => instinct.id)),
    section(
      "Approved Capabilities",
      capabilities.map((ctx) => ctx.capability.id),
    ),
    section(
      "Quality Risks",
      input.qualityRisks ? [input.qualityRisks.id] : [],
      qualityRiskCount,
    ),
    section(
      "Thread Context",
      threadTasks.map((task) => task.taskRunId),
    ),
    section(
      "Recent Artifacts",
      artifacts.slice(0, 6).map((artifact) => artifact.id),
    ),
    section("Repository Context", repoFiles),
    section(
      "Pinned Observations",
      pinnedObservations.map((context) => context.observationId),
    ),
  ].filter((entry) => entry.itemCount > 0);

  const pack: ContextPack = {
    taskRunId: input.taskRun.id,
    counts: {
      instincts: instincts.length,
      capabilities: capabilities.length,
      qualityRisks: qualityRiskCount,
      threadTasks: threadTasks.length,
      recentArtifacts: Math.min(artifacts.length, 6),
      repoFiles: repoFiles.length,
      pinnedObservations: pinnedObservations.length,
    },
    sections,
    sources,
    promptInclusion: {
      instinctIds: instincts.map((instinct) => instinct.id),
      capabilityIds: capabilities.map((ctx) => ctx.capability.id),
      ...(input.qualityRisks ? { qualityGateId: input.qualityRisks.id } : {}),
      threadTaskRunIds: threadTasks.map((task) => task.taskRunId),
      artifactIds: artifacts.slice(0, 6).map((artifact) => artifact.id),
      repoFiles,
      pinnedObservationIds: pinnedObservations.map(
        (context) => context.observationId,
      ),
      pinnedObservationOutcomes,
    },
  };
  if (input.profileId) pack.profileId = input.profileId;
  if (input.profileName) pack.profileName = input.profileName;
  return pack;
};

export const formatContextPackArtifactSummary = (
  pack: ContextPack,
): string => {
  const lines = [
    "# Agent Context Pack",
    "",
    `taskRunId: ${pack.taskRunId}`,
    ...(pack.profileName || pack.profileId
      ? [
          `profile: ${[pack.profileName, pack.profileId ? `(${pack.profileId})` : ""]
            .filter(Boolean)
            .join(" ")}`,
        ]
      : []),
    "",
    "## Counts",
    `- active instincts: ${pack.counts.instincts}`,
    `- approved capabilities: ${pack.counts.capabilities}`,
    `- quality risks: ${pack.counts.qualityRisks}`,
    `- thread tasks: ${pack.counts.threadTasks}`,
    `- recent artifacts: ${pack.counts.recentArtifacts}`,
    `- repo files: ${pack.counts.repoFiles}`,
    `- pinned observations: ${pack.counts.pinnedObservations}`,
    "",
    "## Sections",
    ...(pack.sections.length > 0
      ? pack.sections.map(
          (entry) =>
            `- ${entry.title}: ${entry.itemCount} (${entry.sourceIds.join(", ")})`,
        )
      : ["- none"]),
    "",
    "## Sources",
    ...(pack.sources.length > 0
      ? pack.sources.map((source) =>
          [
            `- ${source.kind} ${source.id}: ${source.title}`,
            source.reason ? ` — ${source.reason}` : "",
          ].join(""),
        )
      : ["- none"]),
    "",
    "```json",
    JSON.stringify(pack, null, 2),
    "```",
  ];
  return lines.join("\n");
};

export const formatContextPackObservationPayload = (
  pack: ContextPack,
  contextPackArtifactId: string,
): Record<string, unknown> => {
  const sourceKinds = emptySourceKindCounts();
  for (const source of pack.sources) {
    sourceKinds[source.kind] += 1;
  }
  return {
    contextPackArtifactId,
    profileId: pack.profileId ?? null,
    profileName: pack.profileName ?? null,
    counts: { ...pack.counts },
    sourceKinds,
    promptInclusion: {
      instinctIds: pack.promptInclusion.instinctIds.slice(),
      capabilityIds: pack.promptInclusion.capabilityIds.slice(),
      qualityGateId: pack.promptInclusion.qualityGateId ?? null,
      threadTaskRunIds: pack.promptInclusion.threadTaskRunIds.slice(),
      artifactIds: pack.promptInclusion.artifactIds.slice(),
      repoFileCount: pack.promptInclusion.repoFiles.length,
      pinnedObservationIds: pack.promptInclusion.pinnedObservationIds.slice(),
      pinnedObservationOutcomes:
        pack.promptInclusion.pinnedObservationOutcomes.map((outcome) => ({
          ...outcome,
        })),
    },
  };
};

const section = (
  title: string,
  sourceIds: string[],
  itemCount = sourceIds.length,
): ContextPackSection => ({
  title,
  itemCount,
  sourceIds,
});

const repoContextFiles = (
  context: PackedRepoContext | string | null | undefined,
): string[] => {
  if (!context || typeof context === "string") return [];
  return context.selectedFiles.slice(0, 12);
};

const compactPinnedObservationOutcome = (
  context: ObservationRecallResult,
): ContextPackPinnedObservationOutcome | null => {
  if (!context.outcome) return null;
  const outcome: ContextPackPinnedObservationOutcome = {
    observationId: context.observationId,
    usedCount: context.outcome.usedCount,
    passedCount: context.outcome.passedCount,
    warningCount: context.outcome.warningCount,
    failedCount: context.outcome.failedCount,
    qualityOutcomeCount: context.outcome.qualityOutcomeCount,
    agentOutcomeCount: context.outcome.agentOutcomeCount,
    runnerOutcomeCount: context.outcome.runnerOutcomeCount,
    unknownOutcomeCount: context.outcome.unknownOutcomeCount,
    scoreAdjustment: context.outcome.scoreAdjustment,
    reuseRisk: context.outcome.reuseRisk,
  };
  if (context.outcome.lastStatus) {
    outcome.lastStatus = context.outcome.lastStatus;
  }
  if (context.outcome.lastOutcomeSource) {
    outcome.lastOutcomeSource = context.outcome.lastOutcomeSource;
  }
  if (context.outcome.lastSeenAt) {
    outcome.lastSeenAt = context.outcome.lastSeenAt;
  }
  return outcome;
};

const emptySourceKindCounts = (): Record<ContextPackSourceKind, number> => ({
  instinct: 0,
  capability: 0,
  quality_gate: 0,
  artifact: 0,
  thread_task: 0,
  repo_context: 0,
  pinned_observation: 0,
});
