import {
  LEARNER_TASK_NOT_FOUND,
  type AgentProfile,
  type Approval,
  type BudgetUsageDailyPoint,
  type BudgetUsageProfileSummary,
  type BudgetUsageSummary,
  type CapabilitySuggestion,
  type ContextOutcomeSummary,
  type ContextOutcomeSummaryInput,
  type EffortHint,
  type TaskRunCostBudgetProgress,
  type TaskRunCostBudgetScope,
  type TaskRunCostStatusCounts,
  type TaskRunCostSummary,
  type LearnerDecisionRecord,
  type LearnerContextDecisionRecord,
  type LearnerModelContext,
  type LearnerRecommendation,
  type LearnerRecommendationApprovalResult,
  type LearningTrace,
  type ObservationRecallInput,
  type ObservationRecallResult,
  type TaskRun,
  evaluateApprovalActionPolicy,
} from "@harness/core";

export class LearnerAdvisorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LearnerAdvisorError";
    this.code = code;
  }
}
import type { LocalStateService } from "@harness/storage";
import { suggestCapabilities } from "@harness/skillify-adapter";
import { recommendModel } from "./model-selection-feedback.ts";
import { aggregateReward } from "./reward-evaluator.ts";
import { traceSimilarity } from "./learning-trace.ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { newId } from "@harness/storage";
import { redactSecrets } from "./redact-secrets.ts";
import { deriveProjectKey } from "./project-key.ts";
import { ObservationRecallService } from "./observation-recall.ts";
import { ContextObservabilityService } from "./context-observability.ts";

/**
 * Phase 6 advisor. Composes capability suggestions (Phase 5) with
 * historical LearningTrace stats to produce a single recommendation
 * per TaskRun. Never executes actions or modifies TaskRun state.
 *
 * Decision recording is append-only: a JSONL file under userData/learner-decisions.log
 * captures accept/reject, mirrored on disk so we can audit recommendations
 * even if the user clears the SQLite database.
 */

const RECOMMENDED_CONTEXT_LIMIT = 3;

export interface LearnerAdvisorDeps {
  state: LocalStateService;
  /**
   * Directory on disk where decision audit lines are appended.
   * Caller must pass an absolute path; the file is created lazily.
   */
  decisionLogDir: string;
}

export class LearnerAdvisor {
  private readonly deps: LearnerAdvisorDeps;
  constructor(deps: LearnerAdvisorDeps) {
    this.deps = deps;
  }

  async recommend(input: {
    taskRunId: string;
  }): Promise<LearnerRecommendation> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const [capabilities, traces, recommendedContext] = await Promise.all([
      this.deps.state.listCapabilities(),
      this.deps.state.listLearningTraces(),
      recommendedContextForTaskRun({
        state: this.deps.state,
        taskRun,
      }),
    ]);
    const baseSuggestions = suggestCapabilities({
      prompt: taskRun.userRequest,
      capabilities,
    });
    const reranked = rerankWithTraceHistory(baseSuggestions, traces);
    const modelChoice = recommendModel(traces);
    const aggregated = aggregateReward(traces);
    const costHint = inferCostHint(traces);
    const latencyHint = inferLatencyHint(traces);
    const rationale = buildRationale({
      reranked,
      modelChoice,
      aggregated,
      hasHistory: traces.length > 0,
    });
    const confidence = clamp(
      modelChoice.confidence * 0.5 +
        Math.min(1, traces.length * 0.05) * 0.3 +
        Math.min(1, reranked.length * 0.2) * 0.2,
      0,
      1,
    );

    const recommendation: LearnerRecommendation = {
      id: newId("learningTrace"),
      recommendedCapabilities: reranked,
      recommendedContext,
      rationale,
      confidence,
    };
    if (modelChoice.model) recommendation.recommendedModel = modelChoice.model;
    if (modelChoice.estimatedCostUsd !== undefined) {
      recommendation.estimatedCostUsd = modelChoice.estimatedCostUsd;
    }
    if (costHint) recommendation.costHint = costHint;
    if (latencyHint) recommendation.latencyHint = latencyHint;
    return recommendation;
  }

  async recallContext(
    input: ObservationRecallInput,
  ): Promise<ObservationRecallResult[]> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const query =
      typeof input.query === "string" && input.query.trim().length > 0
        ? input.query
        : taskRun.userRequest;
    const recall = new ObservationRecallService({ state: this.deps.state });
    const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
    return recall.recall({
      projectKey,
      query,
      excludeTaskRunId: taskRun.id,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async summarizeContextOutcomes(
    input: ContextOutcomeSummaryInput,
  ): Promise<ContextOutcomeSummary> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const observability = new ContextObservabilityService({
      state: this.deps.state,
    });
    const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
    return observability.summarize({
      taskRunId: taskRun.id,
      projectKey,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  async summarizeTaskRunCost(input: {
    taskRunId: string;
  }): Promise<TaskRunCostSummary> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    const usageIsoDate = new Date().toISOString().slice(0, 10);
    const [summary, invocations, settings, profiles] = await Promise.all([
      this.deps.state.summarizeAgentInvocationCostByTaskRun(input.taskRunId),
      this.deps.state.listAgentInvocationsByTaskRun(input.taskRunId),
      this.deps.state.getSettings(),
      this.deps.state.listAgentProfiles(),
    ]);
    const activeProfile = resolveActiveProfile({
      profiles,
      activeAgentProfileId: settings.activeAgentProfileId,
    });
    const dailyCostUsd = await this.deps.state.sumAgentInvocationCostByDay({
      ...(activeProfile ? { profileId: activeProfile.id } : {}),
      isoDate: usageIsoDate,
    });
    return {
      ...summary,
      agentInvocationStatusCounts: invocations.reduce<TaskRunCostStatusCounts>(
        (acc, invocation) => ({
          ...acc,
          [invocation.status]: acc[invocation.status] + 1,
        }),
        {
          queued: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
        },
      ),
      ...(activeProfile?.permissions.budget
        ? {
            budget: {
              profileId: activeProfile.id,
              profileName: activeProfile.name,
              limits: activeProfile.permissions.budget,
              progress: buildBudgetProgress({
                budget: activeProfile.permissions.budget,
                totalCostUsd: summary.totalCostUsd,
                dailyCostUsd,
                maxInvocationCostUsd: maxInvocationCost(summary),
              }),
              isoDate: usageIsoDate,
            },
          }
        : {}),
    };
  }

  async summarizeBudgetUsage(input: {
    days?: number;
    profileId?: string;
  } = {}): Promise<BudgetUsageSummary> {
    const days = clampDays(input.days);
    const todayIso = new Date().toISOString().slice(0, 10);
    const dateWindow = buildDateWindow(todayIso, days);
    const sinceIso = `${dateWindow[0]}T00:00:00.000Z`;
    const untilIso = `${dateWindow[dateWindow.length - 1]}T23:59:59.999Z`;
    const [profiles, aggregates, topModels] = await Promise.all([
      this.deps.state.listAgentProfiles(),
      this.deps.state.aggregateAgentInvocationCostByProfileAndDay({
        sinceIso,
        untilIso,
        ...(input.profileId ? { profileId: input.profileId } : {}),
      }),
      this.deps.state.summarizeAgentInvocationModelCosts({
        sinceIso,
        untilIso,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        limit: 5,
      }),
    ]);
    const selectedProfiles = input.profileId
      ? profiles.filter((profile) => profile.id === input.profileId)
      : profiles;
    const aggregateProfileIds = new Set(
      aggregates.map((aggregate) => aggregate.profileId),
    );
    const includeUnassignedProfile =
      aggregateProfileIds.has("unassigned") &&
      (!input.profileId || input.profileId === "unassigned");
    const summaryProfiles = [
      ...selectedProfiles,
      ...(includeUnassignedProfile ? [unassignedProfile()] : []),
    ];
    const profileSummaries = summaryProfiles.map((profile) =>
      summarizeBudgetProfile({
        profile,
        aggregates: aggregates.filter(
          (aggregate) => aggregate.profileId === profile.id,
        ),
        dateWindow,
        todayIso,
      }),
    );
    const windowCostUsd = profileSummaries.reduce(
      (sum, profile) => sum + profile.windowCostUsd,
      0,
    );
    const todayCostUsd = profileSummaries.reduce(
      (sum, profile) => sum + profile.todayCostUsd,
      0,
    );
    const windowTokens = profileSummaries.reduce(
      (sum, profile) => sum + (profile.windowTokens ?? 0),
      0,
    );
    const todayTokens = profileSummaries.reduce(
      (sum, profile) => sum + (profile.todayTokens ?? 0),
      0,
    );
    const knownTokenInvocationCount = profileSummaries.reduce(
      (sum, profile) => sum + profileKnownTokenCount(profile),
      0,
    );
    const unknownTokenInvocationCount = profileSummaries.reduce(
      (sum, profile) => sum + (profile.unknownTokenInvocationCount ?? 0),
      0,
    );
    const unknownCostInvocationCount = profileSummaries.reduce(
      (sum, profile) => sum + (profile.unknownCostInvocationCount ?? 0),
      0,
    );
    const knownCostInvocationCount = profileSummaries.reduce(
      (sum, profile) => sum + profileKnownCostCount(profile),
      0,
    );
    return {
      sinceIso,
      untilIso,
      todayIso,
      days,
      todayCostUsd,
      windowCostUsd,
      averageDailyCostUsd: windowCostUsd / days,
      ...budgetTokenUsageFields({
        todayTokens,
        windowTokens,
        averageDailyTokens: windowTokens / days,
        knownTokenInvocationCount,
        unknownTokenInvocationCount,
      }),
      ...costCompletenessFields({
        knownCostInvocationCount,
        unknownCostInvocationCount,
      }),
      profiles: profileSummaries,
      topModels,
    };
  }

  /**
   * Turns the advisory recommendation into explicit approval candidates.
   * It does not change the active agent profile, invoke a CLI, or inject
   * context by itself. The prompt/invocation path later reads only
   * approved `model_use`/`capability_use` rows.
   */
  async proposeRecommendationApprovals(input: {
    taskRunId: string;
  }): Promise<LearnerRecommendationApprovalResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const recommendation = await this.recommend(input);
    const existingApprovals = await this.deps.state.listApprovalsByTaskRun(
      taskRun.id,
    );
    const alreadyProposedModels = new Set(
      existingApprovals
        .filter((a) => a.actionType === "model_use")
        .map((a) => a.proposedAction?.modelUse?.model)
        .filter((model): model is string =>
          typeof model === "string" && model.length > 0,
        ),
    );
    const alreadyProposedCapabilities = new Set(
      existingApprovals
        .filter((a) => a.actionType === "capability_use")
        .map((a) => a.proposedAction?.capabilityUse?.capabilityId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const approvals: Approval[] = [];
    const skipped: LearnerRecommendationApprovalResult["skipped"] = [];
    let checkpointId: string | null = null;

    const ensureCheckpoint = async (): Promise<string> => {
      if (checkpointId !== null) return checkpointId;
      const stepIndex = (
        await this.deps.state.listStepsByTaskRun(taskRun.id)
      ).length;
      const modelLabel = recommendation.recommendedModel ?? "모델 추천 없음";
      const capLabels = recommendation.recommendedCapabilities
        .map((s) => s.capability.name)
        .slice(0, 5)
        .join(", ");
      const step = await this.deps.state.createStep({
        taskRunId: taskRun.id,
        index: stepIndex,
        kind: "approval",
        title: "Learner 추천 승인 대기",
        status: "pending",
        inputSummary: [modelLabel, capLabels].filter(Boolean).join(" / "),
      });
      const checkpoint = await this.deps.state.createCheckpoint({
        taskRunId: taskRun.id,
        stepId: step.id,
        reason: "before_edit",
        stateRef: JSON.stringify({
          taskRunStatus: taskRun.status,
          currentStepId: step.id,
          learnerRecommendationId: recommendation.id,
          recommendedModel: recommendation.recommendedModel ?? null,
          recommendedCapabilityIds:
            recommendation.recommendedCapabilities.map(
              (s) => s.capability.id,
            ),
        }),
        summary: "learner recommendation checkpoint",
      });
      await this.deps.state.setTaskRunCurrentStep(taskRun.id, step.id);
      checkpointId = checkpoint.id;
      return checkpoint.id;
    };

    if (recommendation.recommendedModel) {
      const model = recommendation.recommendedModel.trim();
      if (model.length === 0 || alreadyProposedModels.has(model)) {
        skipped.push({
          kind: "model",
          id: model,
          reason: "이미 같은 모델 추천 approval이 있습니다.",
        });
      } else {
        const approval = await this.deps.state.createApproval({
          taskRunId: taskRun.id,
          checkpointId: await ensureCheckpoint(),
          actionType: "model_use",
          actionSummary: `Learner 모델 추천 사용: ${model} — ${shorten(recommendation.rationale, 160)}`,
          status: "pending",
          policyEvaluation: modelPolicyEvaluation(recommendation.estimatedCostUsd),
          proposedAction: {
            type: "model_use",
            modelUse: {
              model,
              reason: recommendation.rationale,
              recommendationId: recommendation.id,
              confidence: recommendation.confidence,
              ...(recommendation.estimatedCostUsd !== undefined
                ? { estimatedCostUsd: recommendation.estimatedCostUsd }
                : {}),
            },
          },
        });
        approvals.push(approval);
        alreadyProposedModels.add(model);
      }
    }

    for (const suggestion of recommendation.recommendedCapabilities.slice(
      0,
      5,
    )) {
      const capability = suggestion.capability;
      if (alreadyProposedCapabilities.has(capability.id)) {
        skipped.push({
          kind: "capability",
          id: capability.id,
          reason: "이미 같은 capability approval이 있습니다.",
        });
        continue;
      }
      const reason = [
        `Learner trace 추천: ${suggestion.reason}`,
        recommendation.rationale,
      ].join(" ");
      const approval = await this.deps.state.createApproval({
        taskRunId: taskRun.id,
        checkpointId: await ensureCheckpoint(),
        actionType: "capability_use",
        actionSummary: `Learner Skill 추천 사용: ${capability.name} — ${shorten(suggestion.reason, 160)}`,
        status: "pending",
        proposedAction: {
          type: "capability_use",
          capabilityUse: {
            capabilityId: capability.id,
            capabilityName: capability.name,
            reason,
            matchedTerms: suggestion.matchedTerms,
          },
        },
      });
      approvals.push(approval);
      alreadyProposedCapabilities.add(capability.id);
    }

    return { recommendation, approvals, skipped };
  }

  async approvedModelContext(input: {
    taskRunId: string;
  }): Promise<LearnerModelContext | null> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${input.taskRunId} not found`,
      );
    }
    const approvals = await this.deps.state.listApprovalsByTaskRun(taskRun.id);
    for (const approval of approvals) {
      if (approval.actionType !== "model_use") continue;
      if (
        approval.status !== "approved" &&
        approval.status !== "always_approved_for_run" &&
        approval.status !== "executed"
      ) {
        continue;
      }
      const modelUse = approval.proposedAction?.modelUse;
      if (!modelUse?.model) continue;
      return {
        model: modelUse.model,
        reason: modelUse.reason,
        recommendationId: modelUse.recommendationId,
        confidence: modelUse.confidence,
      };
    }
    return null;
  }

  async getTrace(input: {
    taskRunId: string;
  }): Promise<LearningTrace | null> {
    return this.deps.state.getLearningTraceByTaskRun(input.taskRunId);
  }

  async recordDecision(record: LearnerDecisionRecord): Promise<void> {
    const line = JSON.stringify({
      ...record,
      reason: record.reason ? redactSecrets(record.reason, 240) : undefined,
      recordedAt: new Date().toISOString(),
    });
    await fs.mkdir(this.deps.decisionLogDir, { recursive: true });
    const file = join(this.deps.decisionLogDir, "decisions.jsonl");
    await fs.appendFile(file, `${line}\n`, "utf8");
  }

  async recordContextDecision(
    record: LearnerContextDecisionRecord,
  ): Promise<void> {
    const taskRun = await this.deps.state.getTaskRun(record.taskRunId);
    if (!taskRun) {
      throw new LearnerAdvisorError(
        LEARNER_TASK_NOT_FOUND,
        `TaskRun ${record.taskRunId} not found`,
      );
    }
    const observationId = record.observationId.trim();
    if (observationId.length === 0) return;
    const decision = record.decision;
    const surface = record.surface ?? "recall";
    const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
    const payload: Record<string, unknown> = {
      observationId,
      decision,
      surface,
    };
    if (typeof record.score === "number" && Number.isFinite(record.score)) {
      payload.score = Number(record.score.toFixed(6));
    }
    if (record.reuseRisk !== undefined) payload.reuseRisk = record.reuseRisk;
    await this.deps.state.createObservation({
      taskRunId: taskRun.id,
      threadId: taskRun.threadId,
      projectKey,
      source: "learner",
      eventType: "pinned_context_decision",
      signal: decision,
      summary: `user ${decision} recalled context ${observationId}`,
      payload,
    });
  }
}

const resolveActiveProfile = (input: {
  profiles: AgentProfile[];
  activeAgentProfileId?: string;
}): AgentProfile | null =>
  (input.activeAgentProfileId
    ? input.profiles.find((profile) => profile.id === input.activeAgentProfileId)
    : null) ??
  input.profiles.find((profile) => profile.isDefault) ??
  null;

const recommendedContextForTaskRun = async (input: {
  state: LocalStateService;
  taskRun: TaskRun;
}): Promise<ObservationRecallResult[]> => {
  const query = input.taskRun.userRequest;
  if (query.trim().length === 0) return [];
  const projectKey = await deriveProjectKey({
    targetDir: input.taskRun.targetDir,
  });
  const recall = new ObservationRecallService({ state: input.state });
  const candidates = await recall.recall({
    projectKey,
    query,
    excludeTaskRunId: input.taskRun.id,
    limit: RECOMMENDED_CONTEXT_LIMIT * 2,
  });
  return candidates
    .filter((candidate) => candidate.outcome?.reuseRisk !== "high")
    .slice(0, RECOMMENDED_CONTEXT_LIMIT);
};

const buildBudgetProgress = (input: {
  budget: NonNullable<AgentProfile["permissions"]["budget"]>;
  totalCostUsd: number;
  dailyCostUsd: number;
  maxInvocationCostUsd: number;
}): TaskRunCostBudgetProgress[] => {
  const rows: TaskRunCostBudgetProgress[] = [];
  if (typeof input.budget.perInvocationUsd === "number") {
    rows.push(
      progressRow({
        scope: "per_invocation",
        label: "Per invocation",
        usedUsd: input.maxInvocationCostUsd,
        limitUsd: input.budget.perInvocationUsd,
      }),
    );
  }
  if (typeof input.budget.perTaskRunUsd === "number") {
    rows.push(
      progressRow({
        scope: "per_task_run",
        label: "TaskRun",
        usedUsd: input.totalCostUsd,
        limitUsd: input.budget.perTaskRunUsd,
      }),
    );
  }
  if (typeof input.budget.perDayUsd === "number") {
    rows.push(
      progressRow({
        scope: "per_day",
        label: "Today",
        usedUsd: input.dailyCostUsd,
        limitUsd: input.budget.perDayUsd,
      }),
    );
  }
  return rows;
};

const progressRow = (input: {
  scope: TaskRunCostBudgetScope;
  label: string;
  usedUsd: number;
  limitUsd: number;
}): TaskRunCostBudgetProgress => {
  const ratio =
    input.limitUsd > 0
      ? input.usedUsd / input.limitUsd
      : input.usedUsd > 0
        ? 1
        : 0;
  return {
    ...input,
    ratio,
    exceeded: input.usedUsd > input.limitUsd,
  };
};

const maxInvocationCost = (summary: TaskRunCostSummary): number =>
  summary.invocations.reduce(
    (max, invocation) => Math.max(max, invocation.cost),
    0,
  );

const clampDays = (days: number | undefined): number => {
  if (typeof days !== "number" || !Number.isFinite(days)) return 7;
  return Math.max(1, Math.min(90, Math.floor(days)));
};

const buildDateWindow = (todayIso: string, days: number): string[] => {
  const today = new Date(`${todayIso}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (days - index - 1));
    return date.toISOString().slice(0, 10);
  });
};

const summarizeBudgetProfile = (input: {
  profile: AgentProfile;
  aggregates: Array<{
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
  }>;
  dateWindow: string[];
  todayIso: string;
}): BudgetUsageProfileSummary => {
  const byDate = new Map(
    input.aggregates.map((aggregate) => [aggregate.dateIso, aggregate]),
  );
  const daily: BudgetUsageDailyPoint[] = input.dateWindow.map((dateIso) => {
    const row = byDate.get(dateIso);
    return {
      dateIso,
      totalCostUsd: row?.totalCostUsd ?? 0,
      ...(row
        ? dailyTokenUsageFields({
            totalInputTokens: row.totalInputTokens ?? 0,
            totalOutputTokens: row.totalOutputTokens ?? 0,
            totalTokens: row.totalTokens ?? 0,
            knownTokenInvocationCount: row.knownTokenInvocationCount ?? 0,
            unknownTokenInvocationCount: row.unknownTokenInvocationCount ?? 0,
          })
        : {}),
      count: row?.count ?? 0,
      ...(row
        ? costCompletenessFields({
            knownCostInvocationCount:
              row.knownCostInvocationCount ?? row.count,
            unknownCostInvocationCount: row.unknownCostInvocationCount ?? 0,
          })
        : {}),
    };
  });
  const windowCostUsd = daily.reduce((sum, point) => sum + point.totalCostUsd, 0);
  const todayCostUsd =
    daily.find((point) => point.dateIso === input.todayIso)?.totalCostUsd ?? 0;
  const windowTokens = daily.reduce(
    (sum, point) => sum + (point.totalTokens ?? 0),
    0,
  );
  const todayTokens =
    daily.find((point) => point.dateIso === input.todayIso)?.totalTokens ?? 0;
  const knownTokenInvocationCount = daily.reduce(
    (sum, point) => sum + knownTokenCount(point),
    0,
  );
  const unknownTokenInvocationCount = daily.reduce(
    (sum, point) => sum + (point.unknownTokenInvocationCount ?? 0),
    0,
  );
  const unknownCostInvocationCount = daily.reduce(
    (sum, point) => sum + (point.unknownCostInvocationCount ?? 0),
    0,
  );
  const knownCostInvocationCount = daily.reduce(
    (sum, point) => sum + knownCostCount(point),
    0,
  );
  const dailyLimit = input.profile.permissions.budget?.perDayUsd;
  return {
    profileId: input.profile.id,
    profileName: input.profile.name,
    model: input.profile.tuning.model,
    ...(input.profile.permissions.budget
      ? { budget: input.profile.permissions.budget }
      : {}),
    todayCostUsd,
    windowCostUsd,
    averageDailyCostUsd: windowCostUsd / input.dateWindow.length,
    ...profileTokenUsageFields({
      todayTokens,
      windowTokens,
      averageDailyTokens: windowTokens / input.dateWindow.length,
      knownTokenInvocationCount,
      unknownTokenInvocationCount,
    }),
    ...costCompletenessFields({
      knownCostInvocationCount,
      unknownCostInvocationCount,
    }),
    ...(typeof dailyLimit === "number" && dailyLimit > 0
      ? { dailyBudgetRatio: todayCostUsd / dailyLimit }
      : {}),
    daily,
  };
};

const unassignedProfile = (): AgentProfile => ({
  id: "unassigned",
  name: "Unassigned model",
  description: "Agent invocations that were not launched through an Agent Profile.",
  category: "system",
  tags: [],
  provider: "auto",
  role: "coder",
  persona: "",
  tuning: {
    model: "unknown",
    timeoutMs: 0,
    stallTimeoutMs: 0,
    contextDepth: 0,
    systemPromptPrefix: "",
    systemPromptSuffix: "",
  },
  cli: {
    cliPathOverride: "",
    env: {},
    envSecretRefs: {},
  },
  permissions: {
    autoApproveActions: [],
    blockedActions: [],
    allowedSkillIds: [],
    toolAllowlist: [],
    toolDenylist: [],
  },
  mcpServerIds: [],
  skillSourceIds: [],
  isDefault: false,
  createdAt: "",
  updatedAt: "",
});

const rerankWithTraceHistory = (
  suggestions: CapabilitySuggestion[],
  traces: LearningTrace[],
): CapabilitySuggestion[] => {
  if (suggestions.length === 0) return suggestions;
  const candidateIds = new Set(suggestions.map((s) => s.capability.id));
  const traceBoost = new Map<string, number>();
  for (const t of traces) {
    if (typeof t.reward !== "number") continue;
    const sim = traceSimilarity(t, candidateIds);
    if (sim === 0) continue;
    for (const id of t.selectedCapabilities) {
      if (!candidateIds.has(id)) continue;
      const cur = traceBoost.get(id) ?? 0;
      traceBoost.set(id, cur + sim * t.reward);
    }
  }
  return [...suggestions]
    .map((s) => ({
      ...s,
      score: s.score + (traceBoost.get(s.capability.id) ?? 0),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.capability.name.localeCompare(b.capability.name),
    );
};

const inferCostHint = (traces: LearningTrace[]): EffortHint | undefined => {
  const costs = traces
    .map((t) => t.costEstimate)
    .filter((v): v is number => typeof v === "number");
  if (costs.length === 0) return undefined;
  const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
  if (avg < 0.05) return "low";
  if (avg < 0.5) return "medium";
  return "high";
};

const inferLatencyHint = (traces: LearningTrace[]): EffortHint | undefined => {
  const lats = traces
    .map((t) => t.latencyMs)
    .filter((v): v is number => typeof v === "number");
  if (lats.length === 0) return undefined;
  const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
  if (avg < 5_000) return "low";
  if (avg < 60_000) return "medium";
  return "high";
};

const knownCostCount = (input: {
  count?: number;
  knownCostInvocationCount?: number;
}): number => input.knownCostInvocationCount ?? input.count ?? 0;

const knownTokenCount = (input: {
  count?: number;
  totalTokens?: number;
  knownTokenInvocationCount?: number;
}): number =>
  input.totalTokens === undefined
    ? 0
    : input.knownTokenInvocationCount ?? input.count ?? 1;

const profileKnownCostCount = (profile: BudgetUsageProfileSummary): number =>
  profile.daily.reduce((sum, point) => sum + knownCostCount(point), 0);

const profileKnownTokenCount = (profile: BudgetUsageProfileSummary): number =>
  profile.daily.reduce((sum, point) => sum + knownTokenCount(point), 0);

const dailyTokenUsageFields = (input: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  knownTokenInvocationCount: number;
  unknownTokenInvocationCount: number;
}):
  | {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      knownTokenInvocationCount?: number;
      unknownTokenInvocationCount?: number;
    }
  | Record<string, never> => {
  if (input.knownTokenInvocationCount <= 0) return {};
  return {
    totalInputTokens: input.totalInputTokens,
    totalOutputTokens: input.totalOutputTokens,
    totalTokens: input.totalTokens,
    ...(input.unknownTokenInvocationCount > 0
      ? {
          knownTokenInvocationCount: input.knownTokenInvocationCount,
          unknownTokenInvocationCount: input.unknownTokenInvocationCount,
        }
      : {}),
  };
};

const profileTokenUsageFields = (input: {
  todayTokens: number;
  windowTokens: number;
  averageDailyTokens: number;
  knownTokenInvocationCount: number;
  unknownTokenInvocationCount: number;
}):
  | {
      todayTokens: number;
      windowTokens: number;
      averageDailyTokens: number;
      knownTokenInvocationCount?: number;
      unknownTokenInvocationCount?: number;
    }
  | Record<string, never> => {
  if (input.knownTokenInvocationCount <= 0) return {};
  return {
    todayTokens: input.todayTokens,
    windowTokens: input.windowTokens,
    averageDailyTokens: input.averageDailyTokens,
    ...(input.unknownTokenInvocationCount > 0
      ? {
          knownTokenInvocationCount: input.knownTokenInvocationCount,
          unknownTokenInvocationCount: input.unknownTokenInvocationCount,
        }
      : {}),
  };
};

const budgetTokenUsageFields = profileTokenUsageFields;

const costCompletenessFields = (input: {
  knownCostInvocationCount: number;
  unknownCostInvocationCount: number;
}):
  | {
      knownCostInvocationCount: number;
      unknownCostInvocationCount: number;
    }
  | Record<string, never> =>
  input.unknownCostInvocationCount > 0
    ? {
        knownCostInvocationCount: input.knownCostInvocationCount,
        unknownCostInvocationCount: input.unknownCostInvocationCount,
      }
    : {};

const buildRationale = (input: {
  reranked: CapabilitySuggestion[];
  modelChoice: { model?: string; rationale: string; confidence: number };
  aggregated: number;
  hasHistory: boolean;
}): string => {
  if (!input.hasHistory) {
    return "No prior trace history; recommending capability matches with conservative defaults.";
  }
  const top = input.reranked[0];
  const topPart = top
    ? `Top capability "${top.capability.name}" (score ${top.score.toFixed(2)}).`
    : "No capability matches found in history.";
  const modelPart = input.modelChoice.rationale;
  const aggPart = `Aggregate reward across ${
    input.aggregated >= 0 ? "positive" : "mixed"
  } past runs ≈ ${input.aggregated.toFixed(2)}.`;
  return [topPart, modelPart, aggPart].join(" ");
};

const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const modelPolicyEvaluation = (estimatedCostUsd: number | undefined) => {
  const policy = evaluateApprovalActionPolicy("model_use");
  if (estimatedCostUsd !== undefined) {
    policy.costEstimateUsd = estimatedCostUsd;
  }
  return policy;
};
