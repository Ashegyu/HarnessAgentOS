import {
  LEARNER_TASK_NOT_FOUND,
  type Approval,
  type CapabilitySuggestion,
  type EffortHint,
  type LearnerDecisionRecord,
  type LearnerModelContext,
  type LearnerRecommendation,
  type LearnerRecommendationApprovalResult,
  type LearningTrace,
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

/**
 * Phase 6 advisor. Composes capability suggestions (Phase 5) with
 * historical LearningTrace stats to produce a single recommendation
 * per TaskRun. Never executes actions or modifies TaskRun state.
 *
 * Decision recording is append-only: a JSONL file under userData/learner-decisions.log
 * captures accept/reject, mirrored on disk so we can audit recommendations
 * even if the user clears the SQLite database.
 */

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
    const [capabilities, traces] = await Promise.all([
      this.deps.state.listCapabilities(),
      this.deps.state.listLearningTraces(),
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
}

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
