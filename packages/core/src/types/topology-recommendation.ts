import type { AgentPipelineStep, CreateAgentPipelineInput } from "./agent-pipeline.ts";

/**
 * Phase 6 advisory output. A topology recommendation is a read-only draft:
 * it can be applied into the pipeline editor, but it never creates,
 * updates, approves, or executes a pipeline by itself.
 */
export interface TopologyRecommendationSource {
  capabilityIds: readonly string[];
  instinctIds: readonly string[];
  traceIds: readonly string[];
  templatePipelineIds: readonly string[];
}

export interface TopologyRecommendedStep {
  step: AgentPipelineStep;
  rationale: string;
  sourceCapabilityIds: readonly string[];
  sourceInstinctIds: readonly string[];
}

export interface TopologyRecommendation {
  id: string;
  taskRunId: string;
  title: string;
  description: string;
  confidence: number;
  rationale: string;
  warnings: readonly string[];
  source: TopologyRecommendationSource;
  steps: readonly TopologyRecommendedStep[];
  pipelineDraft: CreateAgentPipelineInput;
}

export interface RecommendTopologyInput {
  taskRunId: string;
  maxCandidates?: number;
}
