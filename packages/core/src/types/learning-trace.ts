import type { Approval } from "./approval.ts";
import type { AgentBudget } from "./agent-profile.ts";
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
  estimatedCostUsd?: number;
  recommendedCapabilities: CapabilitySuggestion[];
  rationale: string;
  costHint?: EffortHint;
  latencyHint?: EffortHint;
  confidence: number;
}

export interface LearnerModelContext {
  model: string;
  reason: string;
  recommendationId: string;
  confidence: number;
}

export interface LearnerRecommendationSkipped {
  kind: "model" | "capability";
  id: string;
  reason: string;
}

export interface LearnerRecommendationApprovalResult {
  recommendation: LearnerRecommendation;
  approvals: Approval[];
  skipped: LearnerRecommendationSkipped[];
}

export interface LearnerDecisionRecord {
  taskRunId: string;
  recommendationId: string;
  decision: "accepted" | "rejected";
  reason?: string;
}

export interface TaskRunCostModelBreakdown {
  model: string;
  cost: number;
  latencyMs: number;
  count: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface TaskRunCostInvocationSummary {
  id: string;
  model: string;
  cost: number;
  costKnown?: boolean;
  latencyMs: number;
  createdAt: string;
  success?: boolean;
}

export interface TaskRunCostStatusCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export type TaskRunCostBudgetScope =
  | "per_invocation"
  | "per_task_run"
  | "per_day";

export interface TaskRunCostBudgetProgress {
  scope: TaskRunCostBudgetScope;
  label: string;
  usedUsd: number;
  limitUsd: number;
  ratio: number;
  exceeded: boolean;
}

export interface TaskRunCostBudgetSummary {
  profileId: string;
  profileName: string;
  limits: AgentBudget;
  progress: TaskRunCostBudgetProgress[];
  isoDate: string;
}

export interface TaskRunCostSummary {
  taskRunId: string;
  totalCostUsd: number;
  totalLatencyMs: number;
  invocationCount: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
  perModel: TaskRunCostModelBreakdown[];
  invocations: TaskRunCostInvocationSummary[];
  agentInvocationStatusCounts?: TaskRunCostStatusCounts;
  budget?: TaskRunCostBudgetSummary;
}

export interface LearningTraceProfileDayAggregate {
  profileId: string;
  dateIso: string;
  totalCostUsd: number;
  count: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface BudgetUsageModelSummary {
  model: string;
  totalCostUsd: number;
  invocationCount: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface BudgetUsageDailyPoint {
  dateIso: string;
  totalCostUsd: number;
  count: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface BudgetUsageProfileSummary {
  profileId: string;
  profileName: string;
  model: string;
  budget?: AgentBudget;
  todayCostUsd: number;
  windowCostUsd: number;
  averageDailyCostUsd: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
  dailyBudgetRatio?: number;
  daily: BudgetUsageDailyPoint[];
}

export interface BudgetUsageSummary {
  sinceIso: string;
  untilIso: string;
  todayIso: string;
  days: number;
  todayCostUsd: number;
  windowCostUsd: number;
  averageDailyCostUsd: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
  profiles: BudgetUsageProfileSummary[];
  topModels: BudgetUsageModelSummary[];
}
