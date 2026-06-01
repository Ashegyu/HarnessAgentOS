import type {
  Observation,
  ContextOutcomeSource,
  ObservationRecallOutcome,
  ObservationRecallResult,
  ObservationSource,
} from "@harness/core";
import { redactSecrets } from "./redact-secrets.ts";

export interface ObservationRecallState {
  listObservations(input?: {
    projectKey?: string;
    taskRunId?: string;
    limit?: number;
  }): Promise<Observation[]>;
}

export interface ObservationRecallDeps {
  state: ObservationRecallState;
  defaultScanLimit?: number;
}

export interface ObservationRecallQueryInput {
  query: string;
  projectKey?: string;
  excludeTaskRunId?: string;
  source?: ObservationSource;
  limit?: number;
}

interface RankedObservation {
  observation: Observation;
  score: number;
  outcome?: ObservationRecallOutcome;
}

interface TokenizedObservation {
  observation: Observation;
  tokens: string[];
}

const DEFAULT_SCAN_LIMIT = 400;
const MAX_SCAN_LIMIT = 1000;
const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 25;
const K1 = 1.2;
const B = 0.75;

export class ObservationRecallService {
  private readonly deps: ObservationRecallDeps;

  constructor(deps: ObservationRecallDeps) {
    this.deps = deps;
  }

  async recall(
    input: ObservationRecallQueryInput,
  ): Promise<ObservationRecallResult[]> {
    const queryTerms = unique(tokenize(input.query));
    if (queryTerms.length === 0) return [];

    const scanLimit = clampInteger(
      this.deps.defaultScanLimit ?? DEFAULT_SCAN_LIMIT,
      1,
      MAX_SCAN_LIMIT,
    );
    const listInput: Parameters<ObservationRecallState["listObservations"]>[0] = {
      limit: scanLimit,
    };
    if (input.projectKey !== undefined) listInput.projectKey = input.projectKey;

    const observations = await this.deps.state.listObservations(listInput);
    const outcomeStats = buildOutcomeStats(observations);
    const ranked = applyOutcomeSignals(
      rankObservations({
      observations,
      queryTerms,
      projectKey: input.projectKey,
      excludeTaskRunId: input.excludeTaskRunId,
      source: input.source,
      }),
      outcomeStats,
    );
    const resultLimit = clampInteger(
      input.limit ?? DEFAULT_RESULT_LIMIT,
      1,
      MAX_RESULT_LIMIT,
    );

    return ranked.slice(0, resultLimit).map(toRecallResult);
  }
}

export const rankObservations = (input: {
  observations: readonly Observation[];
  queryTerms: readonly string[];
  projectKey?: string;
  excludeTaskRunId?: string;
  source?: ObservationSource;
}): RankedObservation[] => {
  const docs = input.observations
    .filter((observation) => {
      if (isPinnedContextOutcomeObservation(observation)) {
        return false;
      }
      if (input.projectKey !== undefined && observation.projectKey !== input.projectKey) {
        return false;
      }
      if (
        input.excludeTaskRunId !== undefined &&
        observation.taskRunId === input.excludeTaskRunId
      ) {
        return false;
      }
      if (input.source !== undefined && observation.source !== input.source) {
        return false;
      }
      return true;
    })
    .map((observation): TokenizedObservation => ({
      observation,
      tokens: tokenize(observationRecallText(observation)),
    }))
    .filter((doc) => doc.tokens.length > 0);

  if (docs.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const term of input.queryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.tokens.includes(term)) count += 1;
    }
    documentFrequency.set(term, count);
  }

  const averageLength =
    docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length;

  return docs
    .map((doc): RankedObservation => ({
      observation: doc.observation,
      score: bm25Score({
        doc,
        queryTerms: input.queryTerms,
        documentFrequency,
        corpusSize: docs.length,
        averageLength,
      }),
    }))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.observation.createdAt !== a.observation.createdAt) {
        return b.observation.createdAt.localeCompare(a.observation.createdAt);
      }
      return b.observation.id.localeCompare(a.observation.id);
    });
};

const bm25Score = (input: {
  doc: TokenizedObservation;
  queryTerms: readonly string[];
  documentFrequency: ReadonlyMap<string, number>;
  corpusSize: number;
  averageLength: number;
}): number => {
  const termFrequency = new Map<string, number>();
  for (const token of input.doc.tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const term of input.queryTerms) {
    const tf = termFrequency.get(term) ?? 0;
    if (tf === 0) continue;
    const df = input.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (input.corpusSize - df + 0.5) / (df + 0.5));
    const lengthNorm =
      K1 *
      (1 -
        B +
        B * (input.doc.tokens.length / Math.max(input.averageLength, 1)));
    score += idf * ((tf * (K1 + 1)) / (tf + lengthNorm));
  }

  return score;
};

const observationRecallText = (observation: Observation): string =>
  [
    observation.source,
    observation.eventType,
    observation.signal,
    observation.summary,
  ].join(" ");

const toRecallResult = (
  ranked: RankedObservation,
): ObservationRecallResult => {
  const result: ObservationRecallResult = {
    observationId: ranked.observation.id,
    source: ranked.observation.source,
    eventType: ranked.observation.eventType,
    signal: ranked.observation.signal,
    summary: redactSecrets(ranked.observation.summary, 320),
    score: Number(ranked.score.toFixed(6)),
    createdAt: ranked.observation.createdAt,
  };
  if (ranked.outcome !== undefined) {
    result.outcome = ranked.outcome;
  }
  if (ranked.observation.taskRunId !== undefined) {
    result.taskRunId = ranked.observation.taskRunId;
  }
  if (ranked.observation.threadId !== undefined) {
    result.threadId = ranked.observation.threadId;
  }
  if (ranked.observation.projectKey !== undefined) {
    result.projectKey = ranked.observation.projectKey;
  }
  return result;
};

const applyOutcomeSignals = (
  ranked: RankedObservation[],
  outcomes: ReadonlyMap<string, ObservationRecallOutcome>,
): RankedObservation[] =>
  ranked
    .map((entry): RankedObservation => {
      const outcome = outcomes.get(entry.observation.id);
      if (!outcome) return entry;
      return {
        ...entry,
        score: Math.max(0, entry.score + outcome.scoreAdjustment),
        outcome,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.observation.createdAt !== a.observation.createdAt) {
        return b.observation.createdAt.localeCompare(a.observation.createdAt);
      }
      return b.observation.id.localeCompare(a.observation.id);
    });

const buildOutcomeStats = (
  observations: readonly Observation[],
): Map<string, ObservationRecallOutcome> => {
  const stats = new Map<string, ObservationRecallOutcome>();
  for (const observation of observations) {
    if (!isPinnedContextOutcomeObservation(observation)) continue;
    const status = qualityStatusFromOutcome(observation);
    if (!status) continue;
    for (const id of pinnedObservationIdsFromPayload(observation.payload)) {
      const current =
        stats.get(id) ??
        ({
          usedCount: 0,
          passedCount: 0,
          warningCount: 0,
          failedCount: 0,
          qualityOutcomeCount: 0,
          agentOutcomeCount: 0,
          runnerOutcomeCount: 0,
          unknownOutcomeCount: 0,
          scoreAdjustment: 0,
          reuseRisk: "low",
        } satisfies ObservationRecallOutcome);
      current.usedCount += 1;
      if (status === "passed") current.passedCount += 1;
      if (status === "warning") current.warningCount += 1;
      if (status === "failed") current.failedCount += 1;
      const outcomeSource = contextOutcomeSourceFromPayload(observation.payload);
      if (outcomeSource === "quality") current.qualityOutcomeCount += 1;
      if (outcomeSource === "agent") current.agentOutcomeCount += 1;
      if (outcomeSource === "runner") current.runnerOutcomeCount += 1;
      if (outcomeSource === "unknown") current.unknownOutcomeCount += 1;
      if (
        current.lastSeenAt === undefined ||
        observation.createdAt.localeCompare(current.lastSeenAt) > 0
      ) {
        current.lastSeenAt = observation.createdAt;
        current.lastStatus = status;
        current.lastOutcomeSource = outcomeSource;
      }
      current.reuseRisk = reuseRiskForOutcome(current);
      current.scoreAdjustment = scoreAdjustmentForOutcome(current);
      stats.set(id, current);
    }
  }
  return stats;
};

const isPinnedContextOutcomeObservation = (observation: Observation): boolean =>
  observation.source === "learner" &&
  observation.eventType === "pinned_context_outcome";

const qualityStatusFromOutcome = (
  observation: Observation,
): ObservationRecallOutcome["lastStatus"] | null => {
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

const pinnedObservationIdsFromPayload = (
  payload: Record<string, unknown>,
): string[] => {
  const ids = payload.pinnedObservationIds;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 5);
};

const scoreAdjustmentForOutcome = (
  outcome: Pick<
    ObservationRecallOutcome,
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
    ObservationRecallOutcome,
    "passedCount" | "warningCount" | "failedCount" | "lastStatus"
  >,
): ObservationRecallOutcome["reuseRisk"] => {
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

const tokenize = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

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
