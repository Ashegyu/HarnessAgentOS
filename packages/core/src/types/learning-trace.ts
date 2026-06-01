import type { Approval } from "./approval.ts";
import type { AgentBudget } from "./agent-profile.ts";
import type { CapabilitySuggestion } from "./capability.ts";
import type { ObservationSource } from "./instinct.ts";

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
  recommendedContext: ObservationRecallResult[];
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

export interface ObservationRecallInput {
  taskRunId: string;
  query?: string;
  source?: ObservationSource;
  limit?: number;
}

export interface ObservationRecallResult {
  observationId: string;
  taskRunId?: string;
  threadId?: string;
  projectKey?: string;
  source: ObservationSource;
  eventType: string;
  signal: string;
  summary: string;
  score: number;
  createdAt: string;
  outcome?: ObservationRecallOutcome;
}

export type ObservationReuseRisk = "low" | "medium" | "high";
export type ContextOutcomeSource = "quality" | "agent" | "runner" | "unknown";

export interface ObservationRecallOutcome {
  usedCount: number;
  passedCount: number;
  warningCount: number;
  failedCount: number;
  lastStatus?: "passed" | "warning" | "failed";
  lastOutcomeSource?: ContextOutcomeSource;
  lastSeenAt?: string;
  qualityOutcomeCount: number;
  agentOutcomeCount: number;
  runnerOutcomeCount: number;
  unknownOutcomeCount: number;
  scoreAdjustment: number;
  reuseRisk: ObservationReuseRisk;
}

export interface ContextOutcomeSummaryInput {
  taskRunId: string;
  limit?: number;
}

export interface ContextOutcomeObservationSummary {
  observationId: string;
  summary?: string;
  source?: ObservationSource;
  signal?: string;
  usedCount: number;
  passedCount: number;
  warningCount: number;
  failedCount: number;
  lastStatus?: "passed" | "warning" | "failed";
  lastSeenAt?: string;
  scoreAdjustment: number;
  reuseRisk: ObservationReuseRisk;
}

export interface ContextOutcomeRecentEvent {
  outcomeObservationId: string;
  taskRunId?: string;
  threadId?: string;
  status: "passed" | "warning" | "failed";
  outcomeSource: ContextOutcomeSource;
  summary: string;
  pinnedObservationIds: string[];
  createdAt: string;
}

export interface ContextOutcomePackLinkedOutcome {
  outcomeObservationId: string;
  status: "passed" | "warning" | "failed";
  outcomeSource: ContextOutcomeSource;
  summary: string;
  createdAt: string;
}

export interface ContextOutcomePackSummary {
  contextPackObservationId: string;
  taskRunId?: string;
  threadId?: string;
  contextPackArtifactId?: string;
  pinnedObservationIds: string[];
  createdAt: string;
  outcome?: ContextOutcomePackLinkedOutcome;
}

export type LearnerContextDecision = "pinned" | "unpinned";
export type LearnerContextDecisionSurface = "recommended" | "recall";

export interface LearnerContextDecisionRecord {
  taskRunId: string;
  observationId: string;
  decision: LearnerContextDecision;
  surface?: LearnerContextDecisionSurface;
  score?: number;
  reuseRisk?: ObservationReuseRisk;
}

export interface ContextDecisionRecentEvent {
  decisionObservationId: string;
  taskRunId?: string;
  threadId?: string;
  observationId: string;
  decision: LearnerContextDecision;
  surface: LearnerContextDecisionSurface;
  score?: number;
  reuseRisk?: ObservationReuseRisk;
  createdAt: string;
}

export interface ContextOutcomeSummary {
  taskRunId: string;
  projectKey?: string;
  contextPackCount: number;
  pinnedContextPackCount: number;
  verifiedContextPackCount: number;
  pendingContextPackCount: number;
  outcomeCount: number;
  pinnedObservationUseCount: number;
  passedCount: number;
  warningCount: number;
  failedCount: number;
  qualityOutcomeCount: number;
  agentOutcomeCount: number;
  runnerOutcomeCount: number;
  unknownOutcomeCount: number;
  contextDecisionCount: number;
  contextPinnedDecisionCount: number;
  contextUnpinnedDecisionCount: number;
  topObservations: ContextOutcomeObservationSummary[];
  riskObservations: ContextOutcomeObservationSummary[];
  recentOutcomes: ContextOutcomeRecentEvent[];
  recentContextDecisions: ContextDecisionRecentEvent[];
  recentContextPacks: ContextOutcomePackSummary[];
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
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
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
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  usageApproximate?: boolean;
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
  count: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface BudgetUsageModelSummary {
  model: string;
  totalCostUsd: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
  invocationCount: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
}

export interface BudgetUsageDailyPoint {
  dateIso: string;
  totalCostUsd: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
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
  todayTokens?: number;
  windowTokens?: number;
  averageDailyTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
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
  todayTokens?: number;
  windowTokens?: number;
  averageDailyTokens?: number;
  knownTokenInvocationCount?: number;
  unknownTokenInvocationCount?: number;
  knownCostInvocationCount?: number;
  unknownCostInvocationCount?: number;
  profiles: BudgetUsageProfileSummary[];
  topModels: BudgetUsageModelSummary[];
}
