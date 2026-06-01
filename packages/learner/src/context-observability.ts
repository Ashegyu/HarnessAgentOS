import type {
  ContextDecisionRecentEvent,
  ContextOutcomePackLinkedOutcome,
  ContextOutcomePackSummary,
  ContextOutcomeRecentEvent,
  ContextOutcomeObservationSummary,
  ContextOutcomeSummary,
  ContextOutcomeSummaryInput,
  ContextOutcomeSource,
  LearnerContextDecision,
  LearnerContextDecisionSurface,
  Observation,
  ObservationRecallOutcome,
} from "@harness/core";
import { redactSecrets } from "./redact-secrets.ts";

export interface ContextObservabilityState {
  listObservations(input?: {
    projectKey?: string;
    taskRunId?: string;
    limit?: number;
  }): Promise<Observation[]>;
}

export interface ContextObservabilityDeps {
  state: ContextObservabilityState;
  defaultScanLimit?: number;
}

export interface ContextObservabilityQueryInput
  extends ContextOutcomeSummaryInput {
  projectKey?: string;
}

type QualityStatus = NonNullable<ObservationRecallOutcome["lastStatus"]>;

interface MutableOutcomeSummary extends ContextOutcomeObservationSummary {
  usedCount: number;
  passedCount: number;
  warningCount: number;
  failedCount: number;
}

const DEFAULT_SCAN_LIMIT = 400;
const MAX_SCAN_LIMIT = 1000;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 25;

export class ContextObservabilityService {
  private readonly deps: ContextObservabilityDeps;

  constructor(deps: ContextObservabilityDeps) {
    this.deps = deps;
  }

  async summarize(
    input: ContextObservabilityQueryInput,
  ): Promise<ContextOutcomeSummary> {
    const scanLimit = clampInteger(
      this.deps.defaultScanLimit ?? DEFAULT_SCAN_LIMIT,
      1,
      MAX_SCAN_LIMIT,
    );
    const listInput: Parameters<
      ContextObservabilityState["listObservations"]
    >[0] = { limit: scanLimit };
    if (input.projectKey !== undefined) listInput.projectKey = input.projectKey;

    const observations = (await this.deps.state.listObservations(listInput))
      .filter((observation) =>
        input.projectKey === undefined
          ? true
          : observation.projectKey === input.projectKey,
      );

    const sourceById = new Map(
      observations.map((observation) => [observation.id, observation]),
    );
    const contextPacks = observations.filter(isContextPackObservation);
    const outcomeStats = new Map<string, MutableOutcomeSummary>();
    const latestOutcomeByContextPackId =
      new Map<string, ContextOutcomePackLinkedOutcome>();
    let outcomeCount = 0;
    let pinnedObservationUseCount = 0;
    let passedCount = 0;
    let warningCount = 0;
    let failedCount = 0;
    let qualityOutcomeCount = 0;
    let agentOutcomeCount = 0;
    let runnerOutcomeCount = 0;
    let unknownOutcomeCount = 0;
    let contextDecisionCount = 0;
    let contextPinnedDecisionCount = 0;
    let contextUnpinnedDecisionCount = 0;
    const recentOutcomes: ContextOutcomeRecentEvent[] = [];
    const recentContextDecisions: ContextDecisionRecentEvent[] = [];

    for (const observation of observations) {
      if (isPinnedContextDecisionObservation(observation)) {
        const decision = contextDecisionFromObservation(observation);
        const observationId = observationIdFromContextDecisionPayload(
          observation.payload,
        );
        if (decision && observationId) {
          contextDecisionCount += 1;
          if (decision === "pinned") contextPinnedDecisionCount += 1;
          if (decision === "unpinned") contextUnpinnedDecisionCount += 1;
          recentContextDecisions.push(
            createRecentContextDecision({
              observation,
              observationId,
              decision,
            }),
          );
        }
        continue;
      }
      if (!isPinnedContextOutcomeObservation(observation)) continue;
      const status = qualityStatusFromOutcome(observation);
      if (!status) continue;
      const pinnedObservationIds = pinnedObservationIdsFromPayload(
        observation.payload,
      );
      if (pinnedObservationIds.length === 0) continue;

      outcomeCount += 1;
      if (status === "passed") passedCount += 1;
      if (status === "warning") warningCount += 1;
      if (status === "failed") failedCount += 1;
      const outcomeSource = contextOutcomeSourceFromPayload(observation.payload);
      if (outcomeSource === "quality") qualityOutcomeCount += 1;
      if (outcomeSource === "agent") agentOutcomeCount += 1;
      if (outcomeSource === "runner") runnerOutcomeCount += 1;
      if (outcomeSource === "unknown") unknownOutcomeCount += 1;
      recentOutcomes.push(
        createRecentOutcome({
          observation,
          status,
          outcomeSource,
          pinnedObservationIds,
        }),
      );
      const contextPackObservationId = contextPackObservationIdFromPayload(
        observation.payload,
      );
      if (contextPackObservationId) {
        const current = latestOutcomeByContextPackId.get(contextPackObservationId);
        if (
          current === undefined ||
          observation.createdAt.localeCompare(current.createdAt) > 0
        ) {
          latestOutcomeByContextPackId.set(
            contextPackObservationId,
            createLinkedOutcome({
              observation,
              status,
              outcomeSource,
            }),
          );
        }
      }

      for (const id of pinnedObservationIds) {
        pinnedObservationUseCount += 1;
        const current =
          outcomeStats.get(id) ?? createObservationSummary(id, sourceById);
        current.usedCount += 1;
        if (status === "passed") current.passedCount += 1;
        if (status === "warning") current.warningCount += 1;
        if (status === "failed") current.failedCount += 1;
        if (
          current.lastSeenAt === undefined ||
          observation.createdAt.localeCompare(current.lastSeenAt) > 0
        ) {
          current.lastSeenAt = observation.createdAt;
          current.lastStatus = status;
        }
        current.reuseRisk = reuseRiskForOutcome(current);
        current.scoreAdjustment = scoreAdjustmentForOutcome(current);
        outcomeStats.set(id, current);
      }
    }

    const limit = clampInteger(
      input.limit ?? DEFAULT_RESULT_LIMIT,
      1,
      MAX_RESULT_LIMIT,
    );
    const outcomeSummaries = [...outcomeStats.values()];
    const contextPackSummaries = contextPacks
      .map((observation) =>
        createContextPackSummary({
          observation,
          outcome: latestOutcomeByContextPackId.get(observation.id),
        }),
      )
      .filter((item): item is ContextOutcomePackSummary => item !== null);
    const verifiedContextPackCount = contextPackSummaries.filter(
      (item) => item.outcome !== undefined,
    ).length;
    const summary: ContextOutcomeSummary = {
      taskRunId: input.taskRunId,
      contextPackCount: contextPacks.length,
      pinnedContextPackCount: contextPackSummaries.length,
      verifiedContextPackCount,
      pendingContextPackCount:
        contextPackSummaries.length - verifiedContextPackCount,
      outcomeCount,
      pinnedObservationUseCount,
      passedCount,
      warningCount,
      failedCount,
      qualityOutcomeCount,
      agentOutcomeCount,
      runnerOutcomeCount,
      unknownOutcomeCount,
      contextDecisionCount,
      contextPinnedDecisionCount,
      contextUnpinnedDecisionCount,
      topObservations: outcomeSummaries
        .slice()
        .sort(compareOutcomeSummaries)
        .slice(0, limit),
      riskObservations: outcomeSummaries
        .filter(isRiskObservation)
        .sort(compareRiskOutcomeSummaries)
        .slice(0, limit),
      recentOutcomes: recentOutcomes
        .sort(compareRecentOutcomes)
        .slice(0, limit),
      recentContextDecisions: recentContextDecisions
        .sort(compareRecentContextDecisions)
        .slice(0, limit),
      recentContextPacks: contextPackSummaries
        .sort(compareContextPackSummaries)
        .slice(0, limit),
    };
    if (input.projectKey !== undefined) summary.projectKey = input.projectKey;
    return summary;
  }
}

const createObservationSummary = (
  observationId: string,
  sourceById: ReadonlyMap<string, Observation>,
): MutableOutcomeSummary => {
  const source = sourceById.get(observationId);
  const summary: MutableOutcomeSummary = {
    observationId,
    usedCount: 0,
    passedCount: 0,
    warningCount: 0,
    failedCount: 0,
    scoreAdjustment: 0,
    reuseRisk: "low",
  };
  if (source?.summary !== undefined) {
    summary.summary = redactSecrets(source.summary, 240);
  }
  if (source?.source !== undefined) summary.source = source.source;
  if (source?.signal !== undefined) summary.signal = source.signal;
  return summary;
};

const compareOutcomeSummaries = (
  a: ContextOutcomeObservationSummary,
  b: ContextOutcomeObservationSummary,
): number => {
  if (b.usedCount !== a.usedCount) return b.usedCount - a.usedCount;
  if (b.passedCount !== a.passedCount) return b.passedCount - a.passedCount;
  if (a.failedCount !== b.failedCount) return a.failedCount - b.failedCount;
  if ((b.lastSeenAt ?? "") !== (a.lastSeenAt ?? "")) {
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  }
  return a.observationId.localeCompare(b.observationId);
};

const isRiskObservation = (
  observation: ContextOutcomeObservationSummary,
): boolean => observation.failedCount > 0 || observation.reuseRisk === "high";

const riskRank = (
  observation: ContextOutcomeObservationSummary,
): number => {
  if (observation.reuseRisk === "high") return 0;
  if (observation.reuseRisk === "medium") return 1;
  return 2;
};

const compareRiskOutcomeSummaries = (
  a: ContextOutcomeObservationSummary,
  b: ContextOutcomeObservationSummary,
): number => {
  const riskDelta = riskRank(a) - riskRank(b);
  if (riskDelta !== 0) return riskDelta;
  if (b.failedCount !== a.failedCount) return b.failedCount - a.failedCount;
  if (a.scoreAdjustment !== b.scoreAdjustment) {
    return a.scoreAdjustment - b.scoreAdjustment;
  }
  if ((b.lastSeenAt ?? "") !== (a.lastSeenAt ?? "")) {
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  }
  return a.observationId.localeCompare(b.observationId);
};

const createRecentOutcome = (input: {
  observation: Observation;
  status: QualityStatus;
  outcomeSource: ContextOutcomeSource;
  pinnedObservationIds: string[];
}): ContextOutcomeRecentEvent => {
  const event: ContextOutcomeRecentEvent = {
    outcomeObservationId: input.observation.id,
    status: input.status,
    outcomeSource: input.outcomeSource,
    summary: redactSecrets(input.observation.summary, 240),
    pinnedObservationIds: input.pinnedObservationIds,
    createdAt: input.observation.createdAt,
  };
  if (input.observation.taskRunId !== undefined) {
    event.taskRunId = input.observation.taskRunId;
  }
  if (input.observation.threadId !== undefined) {
    event.threadId = input.observation.threadId;
  }
  return event;
};

const createRecentContextDecision = (input: {
  observation: Observation;
  observationId: string;
  decision: LearnerContextDecision;
}): ContextDecisionRecentEvent => {
  const event: ContextDecisionRecentEvent = {
    decisionObservationId: input.observation.id,
    observationId: input.observationId,
    decision: input.decision,
    surface: contextDecisionSurfaceFromPayload(input.observation.payload),
    createdAt: input.observation.createdAt,
  };
  if (input.observation.taskRunId !== undefined) {
    event.taskRunId = input.observation.taskRunId;
  }
  if (input.observation.threadId !== undefined) {
    event.threadId = input.observation.threadId;
  }
  const score = scoreFromContextDecisionPayload(input.observation.payload);
  if (score !== undefined) event.score = score;
  const reuseRisk = reuseRiskFromContextDecisionPayload(input.observation.payload);
  if (reuseRisk !== undefined) event.reuseRisk = reuseRisk;
  return event;
};

const createLinkedOutcome = (input: {
  observation: Observation;
  status: QualityStatus;
  outcomeSource: ContextOutcomeSource;
}): ContextOutcomePackLinkedOutcome => ({
  outcomeObservationId: input.observation.id,
  status: input.status,
  outcomeSource: input.outcomeSource,
  summary: redactSecrets(input.observation.summary, 240),
  createdAt: input.observation.createdAt,
});

const createContextPackSummary = (input: {
  observation: Observation;
  outcome: ContextOutcomePackLinkedOutcome | undefined;
}): ContextOutcomePackSummary | null => {
  const pinnedObservationIds = pinnedObservationIdsFromContextPackPayload(
    input.observation.payload,
  );
  if (pinnedObservationIds.length === 0) return null;
  const summary: ContextOutcomePackSummary = {
    contextPackObservationId: input.observation.id,
    pinnedObservationIds,
    createdAt: input.observation.createdAt,
  };
  if (input.observation.taskRunId !== undefined) {
    summary.taskRunId = input.observation.taskRunId;
  }
  if (input.observation.threadId !== undefined) {
    summary.threadId = input.observation.threadId;
  }
  const contextPackArtifactId = contextPackArtifactIdFromPayload(
    input.observation.payload,
  );
  if (contextPackArtifactId !== undefined) {
    summary.contextPackArtifactId = contextPackArtifactId;
  }
  if (input.outcome !== undefined) summary.outcome = input.outcome;
  return summary;
};

const compareRecentOutcomes = (
  a: ContextOutcomeRecentEvent,
  b: ContextOutcomeRecentEvent,
): number => {
  if (b.createdAt !== a.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.outcomeObservationId.localeCompare(a.outcomeObservationId);
};

const compareRecentContextDecisions = (
  a: ContextDecisionRecentEvent,
  b: ContextDecisionRecentEvent,
): number => {
  if (b.createdAt !== a.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.decisionObservationId.localeCompare(a.decisionObservationId);
};

const compareContextPackSummaries = (
  a: ContextOutcomePackSummary,
  b: ContextOutcomePackSummary,
): number => {
  if (b.createdAt !== a.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.contextPackObservationId.localeCompare(a.contextPackObservationId);
};

const isContextPackObservation = (observation: Observation): boolean =>
  observation.source === "agent" &&
  observation.eventType === "context_pack_created" &&
  observation.signal === "context_pack";

const isPinnedContextOutcomeObservation = (observation: Observation): boolean =>
  observation.source === "learner" &&
  observation.eventType === "pinned_context_outcome";

const isPinnedContextDecisionObservation = (observation: Observation): boolean =>
  observation.source === "learner" &&
  observation.eventType === "pinned_context_decision";

const contextDecisionFromObservation = (
  observation: Observation,
): LearnerContextDecision | null => {
  if (observation.signal === "pinned" || observation.signal === "unpinned") {
    return observation.signal;
  }
  return null;
};

const qualityStatusFromOutcome = (observation: Observation): QualityStatus | null => {
  if (
    observation.signal === "passed" ||
    observation.signal === "warning" ||
    observation.signal === "failed"
  ) {
    return observation.signal;
  }
  const qualityStatus = observation.payload.qualityStatus;
  return qualityStatus === "passed" ||
    qualityStatus === "warning" ||
    qualityStatus === "failed"
    ? qualityStatus
    : null;
};

const observationIdFromContextDecisionPayload = (
  payload: Record<string, unknown>,
): string | null => {
  const observationId = payload.observationId;
  return typeof observationId === "string" && observationId.length > 0
    ? observationId
    : null;
};

const contextDecisionSurfaceFromPayload = (
  payload: Record<string, unknown>,
): LearnerContextDecisionSurface => {
  const surface = payload.surface;
  return surface === "recommended" || surface === "recall" ? surface : "recall";
};

const scoreFromContextDecisionPayload = (
  payload: Record<string, unknown>,
): number | undefined => {
  const score = payload.score;
  return typeof score === "number" && Number.isFinite(score)
    ? Number(score.toFixed(6))
    : undefined;
};

const reuseRiskFromContextDecisionPayload = (
  payload: Record<string, unknown>,
): ContextDecisionRecentEvent["reuseRisk"] | undefined => {
  const reuseRisk = payload.reuseRisk;
  return reuseRisk === "low" || reuseRisk === "medium" || reuseRisk === "high"
    ? reuseRisk
    : undefined;
};

const contextOutcomeSourceFromPayload = (
  payload: Record<string, unknown>,
): ContextOutcomeSource => {
  const raw = payload.outcomeSource;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "quality" || normalized.startsWith("quality.")) {
      return "quality";
    }
    if (normalized === "agent" || normalized.startsWith("agent.")) {
      return "agent";
    }
    if (normalized === "runner" || normalized.startsWith("runner.")) {
      return "runner";
    }
  }
  if (
    typeof payload.qualityGateId === "string" ||
    payload.qualityStatus === "passed" ||
    payload.qualityStatus === "warning" ||
    payload.qualityStatus === "failed"
  ) {
    return "quality";
  }
  return "unknown";
};

const pinnedObservationIdsFromContextPackPayload = (
  payload: Record<string, unknown>,
): string[] => {
  const promptInclusion = payload.promptInclusion;
  if (!isObject(promptInclusion)) return [];
  return pinnedObservationIdsFromPayload(promptInclusion);
};

const contextPackObservationIdFromPayload = (
  payload: Record<string, unknown>,
): string | undefined => {
  const contextPackObservationId = payload.contextPackObservationId;
  return typeof contextPackObservationId === "string" &&
    contextPackObservationId.length > 0
    ? contextPackObservationId
    : undefined;
};

const contextPackArtifactIdFromPayload = (
  payload: Record<string, unknown>,
): string | undefined => {
  const contextPackArtifactId = payload.contextPackArtifactId;
  return typeof contextPackArtifactId === "string" &&
    contextPackArtifactId.length > 0
    ? contextPackArtifactId
    : undefined;
};

const pinnedObservationIdsFromPayload = (
  payload: Record<string, unknown>,
): string[] => {
  const ids = payload.pinnedObservationIds;
  if (!Array.isArray(ids)) return [];
  return unique(
    ids.filter((id): id is string => typeof id === "string" && id.length > 0),
  ).slice(0, 5);
};

const scoreAdjustmentForOutcome = (
  outcome: Pick<
    ContextOutcomeObservationSummary,
    "passedCount" | "warningCount" | "failedCount"
  >,
): number => {
  const raw =
    outcome.passedCount * 0.25 +
    outcome.warningCount * 0.1 -
    outcome.failedCount * 0.35;
  return Number(Math.max(-0.85, Math.min(0.75, raw)).toFixed(2));
};

const reuseRiskForOutcome = (
  outcome: Pick<
    ContextOutcomeObservationSummary,
    "passedCount" | "warningCount" | "failedCount" | "lastStatus"
  >,
): ContextOutcomeObservationSummary["reuseRisk"] => {
  if (
    outcome.failedCount > outcome.passedCount + outcome.warningCount ||
    (outcome.lastStatus === "failed" &&
      outcome.failedCount >= outcome.passedCount)
  ) {
    return "high";
  }
  if (outcome.failedCount > 0 || outcome.warningCount > 0) {
    return "medium";
  }
  return "low";
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const unique = (items: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.trunc(value), max));
};
