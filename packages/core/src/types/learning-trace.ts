import type { CapabilitySuggestion } from "./capability.ts";

export interface LearningTrace {
  id: string;
  taskRunId: string;
  selectedModel?: string;
  selectedCapabilities: string[];
  reward?: number;
  costEstimate?: number;
  latencyMs?: number;
  success?: boolean;
  failureReason?: string;
  createdAt: string;
}

export interface LearningTracePatch {
  selectedModel?: string;
  selectedCapabilities?: string[];
  reward?: number;
  costEstimate?: number;
  latencyMs?: number;
  success?: boolean;
  failureReason?: string;
}

export type EffortHint = "low" | "medium" | "high";

export interface LearnerRecommendation {
  id: string;
  recommendedModel?: string;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: EffortHint;
  latencyHint?: EffortHint;
  confidence: number;
}

export interface LearnerDecisionRecord {
  taskRunId: string;
  recommendationId: string;
  decision: "accepted" | "rejected";
  reason?: string;
}
