import type {
  Approval,
  EvolutionCandidate,
  EvolutionCandidateEvidence,
  EvolutionCandidateEvidenceObservation,
  Instinct,
  Observation,
  QualityGateResult,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { scoreInstinctCandidates } from "./instinct-candidate-scorer.ts";
import { ObservationCollector } from "./observation-collector.ts";
import { redactSecrets } from "./redact-secrets.ts";

export class InstinctServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstinctServiceError";
    this.code = code;
  }
}

export interface InstinctServiceDeps {
  state: LocalStateService;
  collector?: ObservationCollector;
  minSignals?: number;
}

export class InstinctService {
  private readonly deps: InstinctServiceDeps;
  private readonly collector: ObservationCollector;

  constructor(deps: InstinctServiceDeps) {
    this.deps = deps;
    this.collector = deps.collector ?? new ObservationCollector({ state: deps.state });
  }

  async list(input: {
    projectKey?: string;
    includeDisabled?: boolean;
  } = {}): Promise<Instinct[]> {
    return this.deps.state.listInstincts(input);
  }

  async listCandidates(input: {
    projectKey?: string;
  } = {}): Promise<EvolutionCandidate[]> {
    const listInput: Parameters<
      LocalStateService["listEvolutionCandidates"]
    >[0] = { status: "pending" };
    if (input.projectKey) listInput.projectKey = input.projectKey;
    return this.deps.state.listEvolutionCandidates(listInput);
  }

  async getCandidateEvidence(input: {
    candidateId: string;
    limit?: number;
  }): Promise<EvolutionCandidateEvidence> {
    const candidate = await this.deps.state.getEvolutionCandidate(
      input.candidateId,
    );
    if (!candidate) {
      throw new InstinctServiceError(
        "INSTINCT_CANDIDATE_NOT_FOUND",
        `EvolutionCandidate ${input.candidateId} not found`,
      );
    }
    const observationListInput: Parameters<
      LocalStateService["listObservations"]
    >[0] = { limit: 1000 };
    if (candidate.projectKey) {
      observationListInput.projectKey = candidate.projectKey;
    }
    const observations = await this.deps.state.listObservations(
      observationListInput,
    );
    const byId = new Map(
      observations.map((observation) => [observation.id, observation]),
    );
    const limit = clampEvidenceLimit(input.limit);
    const selectedIds = candidate.observationIds.slice(0, limit);
    const evidence: EvolutionCandidateEvidenceObservation[] = [];
    const missingObservationIds: string[] = [];

    for (const observationId of selectedIds) {
      const observation = byId.get(observationId);
      if (!observation) {
        missingObservationIds.push(observationId);
        continue;
      }
      evidence.push(toEvidenceObservation(observation));
    }

    return {
      candidate,
      observationCount: candidate.observationIds.length,
      observations: evidence,
      missingObservationIds,
    };
  }

  async approveCandidate(input: {
    candidateId: string;
    message?: string;
  }): Promise<Instinct> {
    const candidate = await this.deps.state.getEvolutionCandidate(
      input.candidateId,
    );
    if (!candidate) {
      throw new InstinctServiceError(
        "INSTINCT_CANDIDATE_NOT_FOUND",
        `EvolutionCandidate ${input.candidateId} not found`,
      );
    }
    if (candidate.status !== "pending") {
      throw new InstinctServiceError(
        "INSTINCT_CANDIDATE_INVALID_STATE",
        `EvolutionCandidate ${candidate.id} is ${candidate.status}`,
      );
    }
    const instinctInput: Parameters<
      LocalStateService["createInstinct"]
    >[0] = {
      scope: candidate.projectKey ? "project" : "global",
      title: candidate.title,
      rule: candidate.proposedRule,
      rationale: input.message
        ? `${candidate.rationale} User note: ${input.message}`
        : candidate.rationale,
      confidence: candidate.confidence,
      sourceObservationIds: candidate.observationIds,
      tags: ["evolved"],
    };
    if (candidate.projectKey) instinctInput.projectKey = candidate.projectKey;
    const instinct = await this.deps.state.createInstinct(instinctInput);
    await this.deps.state.updateEvolutionCandidateStatus(
      candidate.id,
      "approved",
    );
    return instinct;
  }

  async rejectCandidate(input: {
    candidateId: string;
    message: string;
  }): Promise<EvolutionCandidate> {
    const candidate = await this.deps.state.getEvolutionCandidate(
      input.candidateId,
    );
    if (!candidate) {
      throw new InstinctServiceError(
        "INSTINCT_CANDIDATE_NOT_FOUND",
        `EvolutionCandidate ${input.candidateId} not found`,
      );
    }
    if (candidate.status !== "pending") {
      throw new InstinctServiceError(
        "INSTINCT_CANDIDATE_INVALID_STATE",
        `EvolutionCandidate ${candidate.id} is ${candidate.status}`,
      );
    }
    void input.message;
    return this.deps.state.updateEvolutionCandidateStatus(
      candidate.id,
      "rejected",
    );
  }

  async disable(input: {
    instinctId: string;
    reason: string;
  }): Promise<Instinct> {
    const instinct = await this.deps.state.getInstinct(input.instinctId);
    if (!instinct) {
      throw new InstinctServiceError(
        "INSTINCT_NOT_FOUND",
        `Instinct ${input.instinctId} not found`,
      );
    }
    void input.reason;
    return this.deps.state.updateInstinctStatus(instinct.id, "disabled");
  }

  async recordApprovalDecision(
    approval: Approval,
  ): Promise<Observation | null> {
    const observation = await this.collector.recordApprovalDecision(approval);
    if (observation) {
      await this.refreshForObservation(observation);
    }
    return observation;
  }

  async recordQualityGate(
    result: QualityGateResult,
  ): Promise<Observation | null> {
    const observation = await this.collector.recordQualityGate(result);
    if (observation) {
      await this.refreshForObservation(observation);
    }
    return observation;
  }

  async refreshCandidates(input: {
    projectKey?: string;
  } = {}): Promise<EvolutionCandidate[]> {
    const observationListInput: Parameters<
      LocalStateService["listObservations"]
    >[0] = { limit: 1000 };
    if (input.projectKey) observationListInput.projectKey = input.projectKey;
    const observations =
      await this.deps.state.listObservations(observationListInput);
    const proposed = scoreInstinctCandidates({
      observations,
      minSignals: this.deps.minSignals,
    });
    const existingCandidates = await this.deps.state.listEvolutionCandidates(
      input.projectKey ? { projectKey: input.projectKey } : {},
    );
    const instinctListInput: Parameters<LocalStateService["listInstincts"]>[0] =
      { includeDisabled: true };
    if (input.projectKey) instinctListInput.projectKey = input.projectKey;
    const existingInstincts =
      await this.deps.state.listInstincts(instinctListInput);
    const seen = new Set<string>([
      ...existingCandidates.map(candidateRuleSignature),
      ...existingInstincts.map(instinctRuleSignature),
    ]);
    const created: EvolutionCandidate[] = [];
    for (const candidate of proposed) {
      const signature = candidateRuleSignature(candidate);
      if (seen.has(signature)) continue;
      seen.add(signature);
      created.push(await this.deps.state.createEvolutionCandidate(candidate));
    }
    return created;
  }

  private async refreshForObservation(observation: Observation): Promise<void> {
    const input: { projectKey?: string } = {};
    if (observation.projectKey) input.projectKey = observation.projectKey;
    await this.refreshCandidates(input);
  }
}

const candidateRuleSignature = (
  candidate: Pick<EvolutionCandidate, "projectKey" | "proposedRule">,
): string =>
  [candidate.projectKey ?? "", candidate.proposedRule].join("\u001f");

const instinctRuleSignature = (
  instinct: Pick<Instinct, "projectKey" | "rule">,
): string =>
  [instinct.projectKey ?? "", instinct.rule].join("\u001f");

const toEvidenceObservation = (
  observation: Observation,
): EvolutionCandidateEvidenceObservation => {
  const evidence: EvolutionCandidateEvidenceObservation = {
    observationId: observation.id,
    source: observation.source,
    eventType: observation.eventType,
    signal: observation.signal,
    summary: redactSecrets(observation.summary, 320),
    createdAt: observation.createdAt,
  };
  if (observation.taskRunId !== undefined) {
    evidence.taskRunId = observation.taskRunId;
  }
  if (observation.threadId !== undefined) {
    evidence.threadId = observation.threadId;
  }
  if (observation.projectKey !== undefined) {
    evidence.projectKey = observation.projectKey;
  }
  return evidence;
};

const clampEvidenceLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(Math.trunc(value), 25));
};
