export type ObservationSource =
  | "approval"
  | "quality"
  | "learner"
  | "runner"
  | "skill"
  | "agent";

export type InstinctScope = "global" | "project" | "thread";
export type InstinctStatus = "active" | "disabled" | "rejected";
export type EvolutionCandidateStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "stale";

export interface Observation {
  id: string;
  taskRunId?: string;
  threadId?: string;
  projectKey?: string;
  source: ObservationSource;
  eventType: string;
  signal: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateObservationInput {
  taskRunId?: string;
  threadId?: string;
  projectKey?: string;
  source: ObservationSource;
  eventType: string;
  signal: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface Instinct {
  id: string;
  projectKey?: string;
  scope: InstinctScope;
  title: string;
  rule: string;
  rationale: string;
  confidence: number;
  status: InstinctStatus;
  sourceObservationIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateInstinctInput {
  projectKey?: string;
  scope: InstinctScope;
  title: string;
  rule: string;
  rationale: string;
  confidence: number;
  status?: InstinctStatus;
  sourceObservationIds: string[];
  tags?: string[];
}

export interface EvolutionCandidate {
  id: string;
  projectKey?: string;
  title: string;
  proposedRule: string;
  rationale: string;
  confidence: number;
  status: EvolutionCandidateStatus;
  observationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateEvolutionCandidateInput {
  projectKey?: string;
  title: string;
  proposedRule: string;
  rationale: string;
  confidence: number;
  status?: EvolutionCandidateStatus;
  observationIds: string[];
}
