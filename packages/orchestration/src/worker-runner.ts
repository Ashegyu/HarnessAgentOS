import type { LocalStateService } from "@harness/storage";
import {
  validateProposedActionDetails,
  type A2AEndpoint,
  type A2ARegistryEntry,
  type AgentProfile,
  type AgentProposedAction,
  type Artifact,
  type Approval,
  type ProposedActionDetails,
  workerActionCheckpointSummary,
} from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationPlan,
  type OrchestrationRunResult,
  type PipelineBackflowAttempt,
  type PipelineBackflowEventType,
  type PipelineBackflowTrigger,
  type WorkerBackflowRule,
  type WorkerRole,
  type WorkerStep,
} from "./orchestration-types.ts";
import {
  assertActionTypeAllowed,
  isActionAllowedForWorkerStep,
  orderWorkerStepsByDependencies,
  validateWorkerStep,
} from "./orchestration-policy.ts";
import { formatWorkerStepArtifact } from "./orchestration-trace.ts";
import {
  createInternalAgentMessage,
  type InternalAgentMessage,
} from "./internal-agent-bus.ts";
import {
  buildWorkerHandoffPayload,
  parseWorkerHandoffPayload,
  WORKER_HANDOFF_FENCE,
} from "./worker-handoff.ts";
import { planWorkerWaves } from "./worker-wave-planner.ts";
import { buildEffectiveWorkerDependencyMap } from "./worker-step-dependencies.ts";

/**
 * Minimal CLI invocation contract that the worker-runner depends on.
 * Implemented by `AgentPlanningService.invokeForWorker` in production;
 * tests inject a fake that returns canned text without touching the CLI.
 *
 * Phase 2 policy (a): side-effect-free worker. The implementation MUST
 * NOT execute file_patch / file_write / shell / dependency_install / git_commit /
 * network actions directly. If the model output proposes such an
 * action, the implementation either ignores it or surfaces it as a
 * separate pending approval — never as a side-effect inside this call.
 */
export interface WorkerCliInvoker {
  invokeForWorker(input: {
    taskRunId: string;
    stepId?: string;
    profile: AgentProfile;
    userRequest: string;
    remoteEndpointId?: string;
    handoffMessages?: readonly InternalAgentMessage[];
  }): Promise<{
    outputText: string;
    proposedActions?: AgentProposedAction[];
    lifecycle?: WorkerLifecycleInterruption;
  }>;
}

export type WorkerLifecycleInterruption =
  | {
      kind: "requires_input";
      remoteState?: "input-required";
      message: string;
    }
  | {
      kind: "requires_auth";
      remoteState?: "auth-required";
      message: string;
    };

/**
 * Worker runner deps.
 *
 * Phase 7 kept the worker body deterministic. Phase 2 replaces that
 * stub with real CLI invocation when an `agentPlanning` invoker is
 * provided AND the step references an AgentProfile. When either is
 * absent (legacy mode-driven plans, unit tests) the runner falls back
 * to the deterministic role-based body so the contract stays stable.
 */
export interface WorkerRunnerDeps {
  state: LocalStateService;
  agentPlanning?: WorkerCliInvoker;
  onTaskRunChanged?: (taskRunId: string) => void | Promise<void>;
}

export interface WorkerRunInput {
  approval: Approval;
  plan: OrchestrationPlan;
}

interface PreparedWorkerStep {
  planStep: WorkerStep;
  executionIndex: number;
  profile: AgentProfile | null;
  remoteEndpoint: A2AEndpoint | null;
}

interface WorkerStepExecutionResult {
  planStep: WorkerStep;
  dbStepId: string;
  artifactId: string;
  status: WorkerStep["status"];
  acceptedActions: Array<{
    action: AgentProposedAction;
    details: ProposedActionDetails;
    workerTitle: string;
  }>;
  policyReport: string[];
  handoff: InternalAgentMessage | null;
  lifecycleInterruption: WorkerLifecycleInterruption | null;
}

interface BackflowExecutionContext {
  plan: OrchestrationPlan;
  baseStepIndex: number;
  handoffDependencyIdsByStepId: ReadonlyMap<string, readonly string[]>;
  handoffsByStepId: Map<string, InternalAgentMessage>;
  stepArtifactIds: string[];
  updatedSteps: WorkerStep[];
  latestStatusByStepId: Map<string, WorkerStep["status"]>;
  proposedApprovalIds: string[];
  processWorkerResultSideEffects: (
    result: WorkerStepExecutionResult,
  ) => Promise<void>;
  nextApprovalStepIndex: () => number;
}

interface BackflowExecutionOutcome {
  handled: boolean;
  succeeded: boolean;
  lifecycleInterruption: WorkerLifecycleInterruption | null;
  policyReport: string[];
  lastDbStepId: string | null;
}

export class WorkerRunner {
  private readonly deps: WorkerRunnerDeps;

  constructor(deps: WorkerRunnerDeps) {

    this.deps = deps;

  }

  async runApproved(input: WorkerRunInput): Promise<OrchestrationRunResult> {
    if (input.approval.actionType !== "orchestration_plan") {
      throw new OrchestrationError(
        "ORCH_APPROVAL_TYPE_MISMATCH",
        `Approval ${input.approval.id} is not for an orchestration plan`,
      );
    }
    if (
      input.approval.status !== "approved" &&
      input.approval.status !== "always_approved_for_run"
    ) {
      throw new OrchestrationError(
        "ORCH_APPROVAL_NOT_APPROVED",
        `Approval ${input.approval.id} is ${input.approval.status}`,
      );
    }

    const stepArtifactIds: string[] = [];
    const updatedSteps: WorkerStep[] = [];
    const policyReport: string[] = [];
    let lifecycleInterruption: WorkerLifecycleInterruption | null = null;
    const handoffMessages: InternalAgentMessage[] = [];
    const handoffsByStepId = new Map<string, InternalAgentMessage>();
    for (const step of input.plan.workerSteps) validateWorkerStep(step);
    const handoffDependencyIdsByStepId = buildEffectiveWorkerDependencyMap(
      input.plan.workerSteps,
    );
    orderWorkerStepsByDependencies(input.plan.workerSteps);
    const stepsById = new Map(
      input.plan.workerSteps.map((step) => [step.id, step] as const),
    );
    const remoteEntries = await this.loadRemoteRegistryEntries();
    const executionWaves = planWorkerWaves(
      input.plan.workerSteps,
      remoteEntries,
    ).waves.map((wave) => ({
      parallelizable: wave.parallelizable,
      steps: wave.stepIds.map((stepId) => stepsById.get(stepId)!),
    }));
    const executionIndexByStepId = new Map<string, number>();
    let executionIndex = 0;
    for (const wave of executionWaves) {
      for (const step of wave.steps) {
        executionIndexByStepId.set(step.id, executionIndex);
        executionIndex += 1;
      }
    }
    const baseStepIndex = (
      await this.deps.state.listStepsByTaskRun(input.plan.taskRunId)
    ).length;
    let lastDbStepId: string | null = null;
    const proposedApprovalIds: string[] = [];
    let approvalStepOffset = 0;
    let unresolvedFailure = false;
    let pausedForWorkerApprovals = false;
    const latestStatusByStepId = new Map<string, WorkerStep["status"]>();
    const completedHandoffsByStepId =
      await this.loadCompletedWorkerHandoffs(input.plan);
    const completedPlanStepIds = new Set(completedHandoffsByStepId.keys());
    for (const [stepId, handoff] of completedHandoffsByStepId) {
      latestStatusByStepId.set(stepId, "succeeded");
      handoffsByStepId.set(stepId, handoff);
      handoffMessages.push(handoff);
    }

    const unresolvedPriorApprovalIds =
      await this.listUnresolvedWorkerActionApprovalIdsForPlan(input.plan);
    if (unresolvedPriorApprovalIds.length > 0) {
      await this.deps.state.setTaskRunStatus(
        input.plan.taskRunId,
        "waiting_for_approval",
      );
      return {
        planId: input.plan.id,
        taskRunId: input.plan.taskRunId,
        workerStepArtifactIds: [],
        workerSteps: [],
        proposedApprovalIds: unresolvedPriorApprovalIds,
        needsContinuation: true,
      };
    }

    const processWorkerResultSideEffects = async (
      result: WorkerStepExecutionResult,
    ): Promise<void> => {
      if (result.acceptedActions.length > 0 && result.status === "succeeded") {
        const createdApprovalIds = await this.createWorkerActionApprovals({
          plan: input.plan,
          result,
          approvalStepIndex:
            baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
        });
        approvalStepOffset += 1;
        proposedApprovalIds.push(...createdApprovalIds);
      }
      await this.notifyTaskRunChanged(input.plan.taskRunId);
    };

    const recordResult = (result: WorkerStepExecutionResult): void => {
      stepArtifactIds.push(result.artifactId);
      updatedSteps.push({ ...result.planStep, status: result.status });
      latestStatusByStepId.set(result.planStep.id, result.status);
      lastDbStepId = result.dbStepId;
      if (result.lifecycleInterruption) {
        lifecycleInterruption = result.lifecycleInterruption;
      }
      if (result.handoff) {
        handoffMessages.push(result.handoff);
        handoffsByStepId.set(result.planStep.id, result.handoff);
      }
      policyReport.push(...result.policyReport);
    };

    const handleResult = async (
      result: WorkerStepExecutionResult,
    ): Promise<boolean> => {
      recordResult(result);
      if (result.status !== "failed") return false;
      const backflow = await this.executeBackflowForFailedStep({
        failedResult: result,
        context: {
          plan: input.plan,
          baseStepIndex,
          handoffDependencyIdsByStepId,
          handoffsByStepId,
          stepArtifactIds,
          updatedSteps,
          latestStatusByStepId,
          proposedApprovalIds,
          processWorkerResultSideEffects,
          nextApprovalStepIndex: () =>
            baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
        },
      });
      policyReport.push(...backflow.policyReport);
      if (backflow.lastDbStepId !== null) lastDbStepId = backflow.lastDbStepId;
      if (backflow.lifecycleInterruption) {
        lifecycleInterruption = backflow.lifecycleInterruption;
      }
      return !backflow.handled || !backflow.succeeded;
    };

    for (const wave of executionWaves) {
      const runnableSteps = wave.steps.filter(
        (step) => !completedPlanStepIds.has(step.id),
      );
      if (runnableSteps.length === 0) continue;
      const preparedWave = await Promise.all(
        runnableSteps.map((planStep) =>
          this.prepareWorkerStep(
            planStep,
            executionIndexByStepId.get(planStep.id)!,
          ),
        ),
      );
      const runOne = (prepared: PreparedWorkerStep) =>
        this.runPreparedWorkerStep({
          prepared,
          plan: input.plan,
          baseStepIndex,
          handoffDependencyIdsByStepId,
          handoffsByStepId,
        });
      if (wave.parallelizable) {
        const results = await runParallel(
          preparedWave,
          runOne,
          processWorkerResultSideEffects,
        );
        for (const result of results) {
          if (await handleResult(result)) unresolvedFailure = true;
          if (result.acceptedActions.length > 0 && result.status === "succeeded") {
            pausedForWorkerApprovals = true;
          }
        }
      } else {
        for (const prepared of preparedWave) {
          const result = await runOne(prepared);
          await processWorkerResultSideEffects(result);
          if (await handleResult(result)) {
            unresolvedFailure = true;
            break;
          }
          if (result.acceptedActions.length > 0 && result.status === "succeeded") {
            pausedForWorkerApprovals = true;
            break;
          }
        }
      }
      if (unresolvedFailure || pausedForWorkerApprovals) break;
    }
    if (policyReport.length > 0 && lastDbStepId !== null) {
      const policyArtifact = await this.deps.state.createArtifact({
        taskRunId: input.plan.taskRunId,
        stepId: lastDbStepId,
        kind: "quality_report",
        title: "Worker action policy report",
        uri: `harness:orchestration-policy/${input.plan.id}/${Date.now()}`,
        summary: [
          "# Worker proposed-action policy rejections",
          "",
          `Total rejected: ${policyReport.length}`,
          "",
          ...policyReport,
        ].join("\n"),
      });
      stepArtifactIds.push(policyArtifact.id);
    }
    const hasUnresolvedWorkerApprovals = await this.hasUnresolvedApprovals({
      taskRunId: input.plan.taskRunId,
      approvalIds: proposedApprovalIds,
    });
    const completedAfterRun = new Set([
      ...completedPlanStepIds,
      ...updatedSteps
        .filter((step) => step.status === "succeeded")
        .map((step) => step.id),
    ]);
    const needsContinuation =
      pausedForWorkerApprovals &&
      input.plan.workerSteps.some((step) => !completedAfterRun.has(step.id));
    await this.deps.state.setTaskRunStatus(
      input.plan.taskRunId,
      lifecycleInterruption !== null
        ? "paused"
        : unresolvedFailure ||
            input.plan.workerSteps.some(
              (step) => latestStatusByStepId.get(step.id) === "failed",
            )
          ? "blocked"
          : pausedForWorkerApprovals || hasUnresolvedWorkerApprovals
            ? "waiting_for_approval"
            : "ready_for_review",
    );

    return {
      planId: input.plan.id,
      taskRunId: input.plan.taskRunId,
      workerStepArtifactIds: stepArtifactIds,
      workerSteps: updatedSteps,
      proposedApprovalIds,
      ...(needsContinuation ? { needsContinuation: true } : {}),
    };
  }

  async runQualityBackflow(input: {
    plan: OrchestrationPlan;
    reason: string;
  }): Promise<OrchestrationRunResult | null> {
    const rule = input.plan.backflowRules?.find(
      (candidate) => candidate.trigger === "quality_failed",
    );
    if (!rule) return null;

    const stepArtifactIds: string[] = [];
    const updatedSteps: WorkerStep[] = [];
    const policyReport: string[] = [];
    const proposedApprovalIds: string[] = [];
    const handoffsByStepId = new Map<string, InternalAgentMessage>();
    const latestStatusByStepId = new Map<string, WorkerStep["status"]>();
    const handoffDependencyIdsByStepId = buildEffectiveWorkerDependencyMap(
      input.plan.workerSteps,
    );
    const baseStepIndex = (
      await this.deps.state.listStepsByTaskRun(input.plan.taskRunId)
    ).length;
    let approvalStepOffset = 0;
    let lastDbStepId: string | null = null;
    let lifecycleInterruption: WorkerLifecycleInterruption | null = null;

    for (const step of input.plan.workerSteps) validateWorkerStep(step);
    orderWorkerStepsByDependencies(input.plan.workerSteps);
    await this.deps.state.setTaskRunStatus(input.plan.taskRunId, "running");

    const processWorkerResultSideEffects = async (
      result: WorkerStepExecutionResult,
    ): Promise<void> => {
      if (result.acceptedActions.length > 0 && result.status === "succeeded") {
        const createdApprovalIds = await this.createWorkerActionApprovals({
          plan: input.plan,
          result,
          approvalStepIndex:
            baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
        });
        approvalStepOffset += 1;
        proposedApprovalIds.push(...createdApprovalIds);
      }
      await this.notifyTaskRunChanged(input.plan.taskRunId);
    };

    const outcome = await this.executeBackflowRule({
      rule,
      trigger: "quality_failed",
      reason: input.reason,
      context: {
        plan: input.plan,
        baseStepIndex,
        handoffDependencyIdsByStepId,
        handoffsByStepId,
        stepArtifactIds,
        updatedSteps,
        latestStatusByStepId,
        proposedApprovalIds,
        processWorkerResultSideEffects,
        nextApprovalStepIndex: () =>
          baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
      },
      runDownstreamAfterRetry: true,
    });

    policyReport.push(...outcome.policyReport);
    lastDbStepId = outcome.lastDbStepId;
    lifecycleInterruption = outcome.lifecycleInterruption;
    if (policyReport.length > 0 && lastDbStepId !== null) {
      const policyArtifact = await this.deps.state.createArtifact({
        taskRunId: input.plan.taskRunId,
        stepId: lastDbStepId,
        kind: "quality_report",
        title: "Worker action policy report",
        uri: `harness:orchestration-policy/${input.plan.id}/${Date.now()}`,
        summary: [
          "# Worker proposed-action policy rejections",
          "",
          `Total rejected: ${policyReport.length}`,
          "",
          ...policyReport,
        ].join("\n"),
      });
      stepArtifactIds.push(policyArtifact.id);
    }
    const hasUnresolvedWorkerApprovals = await this.hasUnresolvedApprovals({
      taskRunId: input.plan.taskRunId,
      approvalIds: proposedApprovalIds,
    });
    await this.deps.state.setTaskRunStatus(
      input.plan.taskRunId,
      lifecycleInterruption !== null
        ? "paused"
        : !outcome.succeeded
          ? "blocked"
          : hasUnresolvedWorkerApprovals
            ? "waiting_for_approval"
            : "ready_for_review",
    );
    await this.notifyTaskRunChanged(input.plan.taskRunId);

    return {
      planId: input.plan.id,
      taskRunId: input.plan.taskRunId,
      workerStepArtifactIds: stepArtifactIds,
      workerSteps: updatedSteps,
      proposedApprovalIds,
    };
  }

  private async executeBackflowForFailedStep(input: {
    failedResult: WorkerStepExecutionResult;
    context: BackflowExecutionContext;
  }): Promise<BackflowExecutionOutcome> {
    const rule = input.context.plan.backflowRules?.find(
      (candidate) =>
        candidate.trigger === "step_failed" &&
        candidate.retryStepId === input.failedResult.planStep.id,
    );
    if (!rule) {
      return emptyBackflowOutcome(false);
    }
    return this.executeBackflowRule({
      rule,
      trigger: "step_failed",
      reason: `Worker step failed: ${input.failedResult.planStep.title}`,
      context: input.context,
      failedStepId: input.failedResult.planStep.id,
      runDownstreamAfterRetry: false,
    });
  }

  private async executeBackflowRule(input: {
    rule: WorkerBackflowRule;
    trigger: PipelineBackflowTrigger;
    reason: string;
    context: BackflowExecutionContext;
    failedStepId?: string;
    runDownstreamAfterRetry: boolean;
  }): Promise<BackflowExecutionOutcome> {
    const { context, rule } = input;
    const currentAttemptCount = await this.deps.state.pipelineBackflows.countAttempts({
      taskRunId: context.plan.taskRunId,
      planId: context.plan.id,
      ruleId: rule.id,
      trigger: input.trigger,
    });
    if (currentAttemptCount >= rule.maxAttempts) {
      const attempt = await this.deps.state.pipelineBackflows.createAttempt({
        taskRunId: context.plan.taskRunId,
        planId: context.plan.id,
        ruleId: rule.id,
        trigger: input.trigger,
        targetStepId: rule.targetStepId,
        retryStepId: rule.retryStepId,
        maxAttempts: rule.maxAttempts,
        status: "max_attempts_reached",
        reason: input.reason,
      });
      await this.deps.state.pipelineBackflows.updateAttempt(attempt.id, {
        completedAt: new Date().toISOString(),
      });
      await this.recordBackflowEvent({
        attempt,
        eventType: "max_attempts_reached",
        status: "max_attempts_reached",
        summary: `Backflow max attempts reached for ${rule.id}`,
        reason: input.reason,
        payload: { failedStepId: input.failedStepId },
      });
      return {
        handled: true,
        succeeded: false,
        lifecycleInterruption: null,
        policyReport: [],
        lastDbStepId: null,
      };
    }

    const attempt = await this.deps.state.pipelineBackflows.createAttempt({
      taskRunId: context.plan.taskRunId,
      planId: context.plan.id,
      ruleId: rule.id,
      trigger: input.trigger,
      targetStepId: rule.targetStepId,
      retryStepId: rule.retryStepId,
      maxAttempts: rule.maxAttempts,
      reason: input.reason,
    });
    await this.recordBackflowEvent({
      attempt,
      eventType: "triggered",
      status: "running",
      summary: `Backflow triggered by ${input.trigger}`,
      reason: input.reason,
      payload: { failedStepId: input.failedStepId },
    });

    const targetStep = this.requirePlanStep(context.plan, rule.targetStepId);
    const retryStep = this.requirePlanStep(context.plan, rule.retryStepId);
    const replaySteps = backflowReplayStepsBetween(
      context.plan.workerSteps,
      targetStep.id,
      retryStep.id,
    );
    const policyReport: string[] = [];
    let lifecycleInterruption: WorkerLifecycleInterruption | null = null;
    let lastDbStepId: string | null = null;

    if (
      replaySteps.length === 0 ||
      replaySteps[0]?.id !== targetStep.id ||
      replaySteps[replaySteps.length - 1]?.id !== retryStep.id
    ) {
      await this.failBackflowAttempt({
        attempt,
        reason: `Backflow target is not on retry dependency path: ${targetStep.title} -> ${retryStep.title}`,
        eventPayload: {
          targetStepId: targetStep.id,
          retryStepId: retryStep.id,
        },
      });
      return {
        handled: true,
        succeeded: false,
        lifecycleInterruption: null,
        policyReport,
        lastDbStepId: null,
      };
    }

    for (const replayStep of replaySteps) {
      const isTargetStep = replayStep.id === targetStep.id;
      const isRetryStep = replayStep.id === retryStep.id;
      if (isTargetStep) {
        await this.recordBackflowEvent({
          attempt,
          eventType: "target_started",
          status: "running",
          summary: `Backflow target started: ${targetStep.title}`,
          payload: { targetStepId: targetStep.id },
        });
      }
      if (isRetryStep) {
        await this.recordBackflowEvent({
          attempt,
          eventType: "retry_started",
          status: "running",
          summary: `Backflow retry started: ${retryStep.title}`,
          payload: { retryStepId: retryStep.id },
        });
      }
      const result = await this.runBackflowStep({
        context,
        planStep: replayStep,
      });
      await context.processWorkerResultSideEffects(result);
      this.appendBackflowResult(context, result);
      policyReport.push(...result.policyReport);
      lastDbStepId = result.dbStepId;
      if (result.lifecycleInterruption) {
        lifecycleInterruption = result.lifecycleInterruption;
      }
      if (result.status === "failed") {
        const failureReason = isTargetStep
          ? `Backflow target failed: ${targetStep.title}`
          : isRetryStep
            ? `Backflow retry failed: ${retryStep.title}`
            : `Backflow replay step failed: ${replayStep.title}`;
        await this.failBackflowAttempt({
          attempt,
          reason: failureReason,
          eventPayload: {
            stepId: replayStep.id,
            targetStepId: isTargetStep ? targetStep.id : undefined,
            retryStepId: isRetryStep ? retryStep.id : undefined,
          },
        });
        return {
          handled: true,
          succeeded: false,
          lifecycleInterruption,
          policyReport,
          lastDbStepId,
        };
      }
      if (isTargetStep) {
        await this.recordBackflowEvent({
          attempt,
          eventType: "target_succeeded",
          status: "running",
          summary: `Backflow target succeeded: ${targetStep.title}`,
          payload: { targetStepId: targetStep.id, artifactId: result.artifactId },
        });
      }
      if (isRetryStep) {
        await this.recordBackflowEvent({
          attempt,
          eventType: "retry_succeeded",
          status: "succeeded",
          summary: `Backflow retry succeeded: ${retryStep.title}`,
          payload: { retryStepId: retryStep.id, artifactId: result.artifactId },
        });
      }
    }

    if (input.runDownstreamAfterRetry) {
      const downstream = downstreamStepsAfter(context.plan.workerSteps, retryStep.id);
      for (const downstreamStep of downstream) {
        const result = await this.runBackflowStep({
          context,
          planStep: downstreamStep,
        });
        await context.processWorkerResultSideEffects(result);
        this.appendBackflowResult(context, result);
        policyReport.push(...result.policyReport);
        lastDbStepId = result.dbStepId;
        if (result.lifecycleInterruption) {
          lifecycleInterruption = result.lifecycleInterruption;
        }
        if (result.status === "failed") {
          await this.failBackflowAttempt({
            attempt,
            reason: `Downstream step failed after backflow retry: ${downstreamStep.title}`,
            eventPayload: { downstreamStepId: downstreamStep.id },
          });
          return {
            handled: true,
            succeeded: false,
            lifecycleInterruption,
            policyReport,
            lastDbStepId,
          };
        }
      }
    }

    await this.deps.state.pipelineBackflows.updateAttempt(attempt.id, {
      status: "succeeded",
      completedAt: new Date().toISOString(),
    });
    return {
      handled: true,
      succeeded: true,
      lifecycleInterruption,
      policyReport,
      lastDbStepId,
    };
  }

  private async runBackflowStep(input: {
    context: BackflowExecutionContext;
    planStep: WorkerStep;
    additionalHandoffMessages?: readonly InternalAgentMessage[];
  }): Promise<WorkerStepExecutionResult> {
    const prepared = await this.prepareWorkerStep(input.planStep, 0);
    const stepIndex = (
      await this.deps.state.listStepsByTaskRun(input.context.plan.taskRunId)
    ).length;
    return this.runPreparedWorkerStep({
      prepared,
      plan: input.context.plan,
      baseStepIndex: input.context.baseStepIndex,
      stepIndexOverride: stepIndex,
      handoffDependencyIdsByStepId: input.context.handoffDependencyIdsByStepId,
      handoffsByStepId: input.context.handoffsByStepId,
      additionalHandoffMessages: input.additionalHandoffMessages ?? [],
    });
  }

  private appendBackflowResult(
    context: BackflowExecutionContext,
    result: WorkerStepExecutionResult,
  ): void {
    context.stepArtifactIds.push(result.artifactId);
    context.updatedSteps.push({ ...result.planStep, status: result.status });
    context.latestStatusByStepId.set(result.planStep.id, result.status);
    if (result.handoff) {
      context.handoffsByStepId.set(result.planStep.id, result.handoff);
    }
  }

  private async recordBackflowEvent(input: {
    attempt: PipelineBackflowAttempt;
    eventType: PipelineBackflowEventType;
    status: PipelineBackflowAttempt["status"];
    summary: string;
    reason?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.deps.state.pipelineBackflows.createEvent({
      taskRunId: input.attempt.taskRunId,
      attemptId: input.attempt.id,
      eventType: input.eventType,
      status: input.status,
      summary: input.summary,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
  }

  private async failBackflowAttempt(input: {
    attempt: PipelineBackflowAttempt;
    reason: string;
    eventPayload: Record<string, unknown>;
  }): Promise<void> {
    await this.deps.state.pipelineBackflows.updateAttempt(input.attempt.id, {
      status: "failed",
      reason: input.reason,
      completedAt: new Date().toISOString(),
    });
    await this.recordBackflowEvent({
      attempt: input.attempt,
      eventType: "failed",
      status: "failed",
      summary: input.reason,
      reason: input.reason,
      payload: input.eventPayload,
    });
  }

  private requirePlanStep(plan: OrchestrationPlan, stepId: string): WorkerStep {
    const step = plan.workerSteps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new OrchestrationError(
        "PIPELINE_BACKFLOW_STEP_NOT_FOUND",
        `Backflow rule references unknown worker step ${stepId}`,
      );
    }
    return step;
  }

  private async createWorkerActionApprovals(input: {
    plan: OrchestrationPlan;
    result: WorkerStepExecutionResult;
    approvalStepIndex: number;
  }): Promise<string[]> {
    if (input.result.acceptedActions.length === 0) return [];
    const approvalStep = await this.deps.state.createStep({
      taskRunId: input.plan.taskRunId,
      index: input.approvalStepIndex,
      kind: "approval",
      title: `Worker action 승인 대기 — ${input.result.planStep.title}`,
      status: "pending",
      inputSummary: input.result.acceptedActions
        .map((a) => a.details.type)
        .join(","),
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: input.plan.taskRunId,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus: "waiting_for_approval",
        currentStepId: approvalStep.id,
        artifactIds: [input.result.artifactId],
        orchestrationPlanId: input.plan.id,
      }),
      summary: workerActionCheckpointSummary(input.result.acceptedActions.length),
    });
    const approvalIds: string[] = [];
    for (const { action, details, workerTitle } of input.result.acceptedActions) {
      const approval = await this.deps.state.createApproval({
        taskRunId: input.plan.taskRunId,
        checkpointId: checkpoint.id,
        actionType: details.type,
        actionSummary: shortRationale(action, workerTitle),
        status: "pending",
      });
      const withDetails = await this.deps.state.setApprovalProposedAction(
        approval.id,
        details,
      );
      approvalIds.push(withDetails.id);
    }
    await this.deps.state.setTaskRunCurrentStep(
      input.plan.taskRunId,
      approvalStep.id,
    );
    return approvalIds;
  }

  private async hasUnresolvedApprovals(input: {
    taskRunId: string;
    approvalIds: readonly string[];
  }): Promise<boolean> {
    if (input.approvalIds.length === 0) return false;
    const ids = new Set(input.approvalIds);
    const approvals = await this.deps.state.listApprovalsByTaskRun(
      input.taskRunId,
    );
    return approvals.some(
      (approval) =>
        ids.has(approval.id) &&
        (approval.status === "pending" ||
          approval.status === "approved" ||
          approval.status === "always_approved_for_run"),
    );
  }

  private async listUnresolvedWorkerActionApprovalIdsForPlan(
    plan: OrchestrationPlan,
  ): Promise<string[]> {
    const [approvals, checkpoints] = await Promise.all([
      this.deps.state.listApprovalsByTaskRun(plan.taskRunId),
      this.deps.state.listCheckpointsByTaskRun(plan.taskRunId),
    ]);
    const checkpointPlanIds = new Map<string, string>();
    for (const checkpoint of checkpoints) {
      try {
        const parsed = JSON.parse(checkpoint.stateRef) as {
          orchestrationPlanId?: string;
        };
        if (typeof parsed.orchestrationPlanId === "string") {
          checkpointPlanIds.set(checkpoint.id, parsed.orchestrationPlanId);
        }
      } catch {
        // Non-orchestration checkpoints are ignored.
      }
    }
    return approvals
      .filter(
        (approval) =>
          checkpointPlanIds.get(approval.checkpointId) === plan.id &&
          approval.actionType !== "orchestration_plan" &&
          isUnresolvedApprovalStatus(approval.status),
      )
      .map((approval) => approval.id);
  }

  private async loadCompletedWorkerHandoffs(
    plan: OrchestrationPlan,
  ): Promise<Map<string, InternalAgentMessage>> {
    const artifacts = await this.deps.state.listArtifactsByTaskRun(plan.taskRunId);
    const handoffs = new Map<string, InternalAgentMessage>();
    for (const step of plan.workerSteps) {
      const artifact = latestWorkerArtifactForStep(artifacts, plan.id, step.id);
      if (!artifact) continue;
      handoffs.set(
        step.id,
        createInternalAgentMessage({
          taskRunId: plan.taskRunId,
          planId: plan.id,
          fromStepId: step.id,
          fromRole: step.role,
          fromTitle: step.title,
          content: artifact.summary ?? "",
          artifactId: artifact.id,
          now: () => artifact.createdAt,
          createId: () => `handoff_${artifact.id}`,
        }),
      );
    }
    return handoffs;
  }

  private async notifyTaskRunChanged(taskRunId: string): Promise<void> {
    await this.deps.onTaskRunChanged?.(taskRunId);
  }

  /**
   * Phase 2 worker body. Two paths:
   *
   *   1. Pipeline-driven step + injected CLI invoker → invoke the agent
   *      CLI with the profile's persona/tuning and the step's full
   *      instruction. Capture the agent's text output as the worker
   *      artifact body. Side-effect-free per policy (a): the invoker
   *      MUST NOT execute file_patch/file_write/shell directly.
   *
   *   2. Anything missing (no profile, no invoker, no instruction)
   *      falls back to the Phase 7 deterministic role body so the
   *      legacy mode-driven flow and unit tests keep working.
   */
  private async runWorkerStepBody(
    step: WorkerStep,
    profile: AgentProfile | null,
    taskRunId: string,
    stepId: string,
    remoteEndpoint: A2AEndpoint | null,
    handoffMessages: readonly InternalAgentMessage[],
  ): Promise<{
    body: string;
    proposedActions: AgentProposedAction[];
    lifecycle?: WorkerLifecycleInterruption;
  }> {
    assertActionTypeAllowed(roleToActionIntent(step.role));
    const invoker = this.deps.agentPlanning;
    const taskRun = await this.deps.state.getTaskRun(taskRunId);
    const userRequest = composeWorkerUserRequest({
      originalUserRequest: taskRun?.userRequest ?? "",
      stepInstruction: step.instruction ?? step.inputSummary,
      ...(step.allowedActions !== undefined
        ? { allowedActions: step.allowedActions }
        : {}),
      ...(step.outputContract !== undefined
        ? { outputContract: step.outputContract }
        : {}),
    });
    if (invoker && profile && userRequest.length > 0) {
      const { outputText, proposedActions, lifecycle } =
        await invoker.invokeForWorker({
          taskRunId,
          stepId,
          profile,
          userRequest,
          ...(step.remoteEndpointId !== undefined
            ? { remoteEndpointId: step.remoteEndpointId }
            : {}),
          handoffMessages: [...handoffMessages],
        });
      // Prefix with a small attribution line so the artifact reader
      // sees which profile produced the text. Persona snippet is kept
      // short — full persona is the system prompt the CLI consumed.
      const personaSnippet =
        profile.persona.length > 0
          ? `[${profile.name}${remoteEndpoint ? ` -> Remote A2A ${remoteEndpoint.name}` : ""}] persona: ${profile.persona.slice(0, 140)}\n\n`
          : `[${profile.name}${remoteEndpoint ? ` -> Remote A2A ${remoteEndpoint.name}` : ""}]\n\n`;
      return {
        body: personaSnippet + outputText,
        proposedActions: proposedActions ?? [],
        ...(lifecycle ? { lifecycle } : {}),
      };
    }
    // Fallback: deterministic stub.
    const personaLine =
      profile && profile.persona.length > 0
        ? `[${profile.name}${remoteEndpoint ? ` -> Remote A2A ${remoteEndpoint.name}` : ""}] persona: ${profile.persona.slice(0, 140)}\n\n`
        : "";
    return {
      body: personaLine + roleBody(step.role),
      proposedActions: [],
    };
  }

  private async prepareWorkerStep(
    planStep: WorkerStep,
    executionIndex: number,
  ): Promise<PreparedWorkerStep> {
    // When the step references a specific AgentProfile (pipeline-driven
    // plans), fail-fast if that profile has been deleted since draft.
    // Falling back to a default profile would silently change the
    // persona/permissions the user approved, so we refuse to run.
    let profile = null;
    if (planStep.agentProfileId) {
      profile = await this.deps.state.agentProfiles.get(planStep.agentProfileId);
      if (!profile) {
        throw new OrchestrationError(
          "PIPELINE_REFERENCED_PROFILE_MISSING",
          `Worker step "${planStep.title}" references missing profile ${planStep.agentProfileId}`,
        );
      }
    }
    let remoteEndpoint: A2AEndpoint | null = null;
    if (planStep.remoteEndpointId) {
      remoteEndpoint = await this.deps.state.a2aRemoteAgents.getEndpoint(
        planStep.remoteEndpointId,
      );
      if (!remoteEndpoint) {
        throw new OrchestrationError(
          "PIPELINE_REFERENCED_REMOTE_ENDPOINT_MISSING",
          `Worker step "${planStep.title}" references missing remote endpoint ${planStep.remoteEndpointId}`,
        );
      }
      if (!remoteEndpoint.enabled || !remoteEndpoint.trusted) {
        throw new OrchestrationError(
          "PIPELINE_REMOTE_ENDPOINT_UNAVAILABLE",
          `Worker step "${planStep.title}" references unavailable remote endpoint ${planStep.remoteEndpointId}`,
        );
      }
    }
    return {
      planStep,
      executionIndex,
      profile,
      remoteEndpoint,
    };
  }

  private async runPreparedWorkerStep(input: {
    prepared: PreparedWorkerStep;
    plan: OrchestrationPlan;
    baseStepIndex: number;
    stepIndexOverride?: number;
    handoffDependencyIdsByStepId: ReadonlyMap<string, readonly string[]>;
    handoffsByStepId: ReadonlyMap<string, InternalAgentMessage>;
    additionalHandoffMessages?: readonly InternalAgentMessage[];
  }): Promise<WorkerStepExecutionResult> {
    const { planStep, executionIndex, profile, remoteEndpoint } =
      input.prepared;
    const dbStep = await this.deps.state.createStep({
      taskRunId: input.plan.taskRunId,
      index: input.stepIndexOverride ?? input.baseStepIndex + executionIndex,
      kind: "summarize",
      title:
        profile && remoteEndpoint
          ? `Worker[${profile.name} -> ${remoteEndpoint.name}] ${planStep.title}`
          : profile
            ? `Worker[${profile.name}] ${planStep.title}`
            : `Worker[${planStep.role}] ${planStep.title}`,
      status: "running",
      inputSummary: planStep.inputSummary,
    });
    await this.deps.state.setTaskRunCurrentStep(input.plan.taskRunId, dbStep.id);
    await this.deps.state.setTaskRunStatus(input.plan.taskRunId, "running");

    let body: string;
    let status: WorkerStep["status"] = "succeeded";
    let proposedActions: AgentProposedAction[] = [];
    let lifecycleInterruption: WorkerLifecycleInterruption | null = null;
    try {
      const outcome = await this.runWorkerStepBody(
        planStep,
        profile,
        input.plan.taskRunId,
        dbStep.id,
        remoteEndpoint,
        resolveHandoffsForStep(
          input.handoffDependencyIdsByStepId.get(planStep.id) ?? [],
          input.handoffsByStepId,
        ).concat(input.additionalHandoffMessages ?? []),
      );
      body = outcome.body;
      proposedActions = outcome.proposedActions;
      if (outcome.lifecycle) {
        lifecycleInterruption = outcome.lifecycle;
        body = lifecycleBody(outcome.lifecycle, body);
        status = "failed";
        proposedActions = [];
      }
      if (status === "succeeded") {
        proposedActions = mergeProposedActions(
          proposedActions,
          extractStructuredHandoffProposedActions(body),
        );
      }
    } catch (e) {
      body = e instanceof Error ? e.message : String(e);
      status = "failed";
    }

    const artifact = await this.deps.state.createArtifact({
      taskRunId: input.plan.taskRunId,
      stepId: dbStep.id,
      kind: "log",
      title: `Worker output: ${planStep.title}`,
      uri: `harness:orchestration/${input.plan.id}/${planStep.id}`,
      summary: formatWorkerStepArtifact({
        step: { ...planStep, status },
        output: body,
        ...(profile ? { profileName: profile.name } : {}),
        ...(remoteEndpoint ? { remoteEndpointName: remoteEndpoint.name } : {}),
      }),
    });
    await this.deps.state.setStepStatus(dbStep.id, status, {
      outputSummary: `worker artifact ${artifact.id}`,
    });

    const acceptedActions: WorkerStepExecutionResult["acceptedActions"] = [];
    const policyReport: string[] = [];
    if (status === "succeeded" && proposedActions.length > 0) {
      for (const [proposalIndex, raw] of proposedActions.entries()) {
        const details = toProposedActionDetails(raw);
        if (!isActionAllowedForWorkerStep(planStep, details.type)) {
          policyReport.push(
            `- ${planStep.title} [${proposalIndex}] ${raw.type} rejected: not allowed for this worker step`,
          );
          continue;
        }
        const validation = validateProposedActionDetails(details, raw.type);
        if (!validation.ok || !validation.details) {
          policyReport.push(
            `- ${planStep.title} [${proposalIndex}] ${raw.type} rejected: ${
              validation.reason ?? "invalid"
            }`,
          );
          continue;
        }
        acceptedActions.push({
          action: raw,
          details: validation.details,
          workerTitle: planStep.title,
        });
      }
    }
    const handoff =
      status === "succeeded"
        ? createInternalAgentMessage({
            taskRunId: input.plan.taskRunId,
            planId: input.plan.id,
            fromStepId: planStep.id,
            fromRole: planStep.role,
            fromTitle: planStep.title,
            content: body,
            structuredPayload: buildWorkerHandoffPayload({
              rawOutput: body,
              producer: {
                taskRunId: input.plan.taskRunId,
                planId: input.plan.id,
                stepId: planStep.id,
                role: planStep.role,
                title: planStep.title,
                artifactId: artifact.id,
              },
              ...(planStep.outputContract !== undefined
                ? { outputContract: planStep.outputContract }
                : {}),
              proposedActions: acceptedActions.map(({ action }) => action),
            }).payload,
            artifactId: artifact.id,
          })
        : null;

    return {
      planStep,
      dbStepId: dbStep.id,
      artifactId: artifact.id,
      status,
      acceptedActions,
      policyReport,
      handoff,
      lifecycleInterruption,
    };
  }

  private async loadRemoteRegistryEntries(): Promise<A2ARegistryEntry[]> {
    const endpoints = await this.deps.state.a2aRemoteAgents.listEndpoints();
    return Promise.all(
      endpoints.map(async (endpoint) => {
        const card = await this.deps.state.a2aRemoteAgents.getCardSnapshot(
          endpoint.id,
        );
        return card ? { endpoint, card } : { endpoint };
      }),
    );
  }
}

const emptyBackflowOutcome = (handled: boolean): BackflowExecutionOutcome => ({
  handled,
  succeeded: false,
  lifecycleInterruption: null,
  policyReport: [],
  lastDbStepId: null,
});

const backflowReplayStepsBetween = (
  steps: readonly WorkerStep[],
  targetStepId: string,
  retryStepId: string,
): WorkerStep[] => {
  const stepIds = new Set(steps.map((step) => step.id));
  if (!stepIds.has(targetStepId) || !stepIds.has(retryStepId)) return [];
  const dependencyIdsByStepId = buildEffectiveWorkerDependencyMap(steps);
  const dependentIdsByStepId = new Map<string, string[]>();
  for (const stepId of stepIds) dependentIdsByStepId.set(stepId, []);
  for (const [stepId, dependencyIds] of dependencyIdsByStepId.entries()) {
    for (const depId of dependencyIds) {
      if (!stepIds.has(depId)) continue;
      dependentIdsByStepId.get(depId)?.push(stepId);
    }
  }

  const descendantsOfTarget = new Set<string>();
  const collectDescendants = (stepId: string): void => {
    if (descendantsOfTarget.has(stepId)) return;
    descendantsOfTarget.add(stepId);
    for (const dependentId of dependentIdsByStepId.get(stepId) ?? []) {
      collectDescendants(dependentId);
    }
  };
  collectDescendants(targetStepId);

  const ancestorsOfRetry = new Set<string>();
  const collectAncestors = (stepId: string): void => {
    if (ancestorsOfRetry.has(stepId)) return;
    ancestorsOfRetry.add(stepId);
    for (const depId of dependencyIdsByStepId.get(stepId) ?? []) {
      if (stepIds.has(depId)) collectAncestors(depId);
    }
  };
  collectAncestors(retryStepId);

  const orderedSteps = orderWorkerStepsByDependencies([...steps]);
  return orderedSteps.filter(
    (step) =>
      descendantsOfTarget.has(step.id) && ancestorsOfRetry.has(step.id),
  );
};

const downstreamStepsAfter = (
  steps: readonly WorkerStep[],
  retryStepId: string,
): WorkerStep[] => {
  const stepIds = new Set(steps.map((step) => step.id));
  const depsByStepId = buildEffectiveWorkerDependencyMap(steps);
  const hasRetryAncestor = (stepId: string, visiting = new Set<string>()): boolean => {
    if (stepId === retryStepId) return true;
    if (visiting.has(stepId)) return false;
    visiting.add(stepId);
    const deps = depsByStepId.get(stepId) ?? [];
    return deps.some((depId) =>
      stepIds.has(depId) ? hasRetryAncestor(depId, visiting) : false,
    );
  };
  const order = orderWorkerStepsByDependencies([...steps]);
  return order.filter(
    (step) => step.id !== retryStepId && hasRetryAncestor(step.id),
  );
};

const runParallel = async <T, R>(
  items: readonly T[],
  runOne: (item: T) => Promise<R>,
  onResult: (result: R) => Promise<void>,
): Promise<R[]> => {
  let sideEffectQueue: Promise<void> = Promise.resolve();
  const processResult = async (result: R): Promise<void> => {
    const next = sideEffectQueue.then(() => onResult(result));
    sideEffectQueue = next.catch(() => {});
    await next;
  };
  const results = await Promise.all(
    items.map(async (item) => {
      const result = await runOne(item);
      await processResult(result);
      return result;
    }),
  );
  await sideEffectQueue;
  return results;
};

const roleBody = (role: WorkerRole): string => {
  switch (role) {
    case "planner":
      return [
        "Planner produced an outline:",
        "- Identify scope of change",
        "- Decompose into approval-bound actions",
      ].join("\n");
    case "coder":
      return [
        "Coder summarized intended edits:",
        "- (No file writes performed; create approvals via conversation flow.)",
      ].join("\n");
    case "reviewer":
      return [
        "Reviewer noted risks:",
        "- Verify tests cover changed paths",
        "- Confirm targetDir scope",
      ].join("\n");
    case "tester":
      return [
        "Tester proposed test additions:",
        "- Run existing suite",
        "- Add a regression test for the failing path",
      ].join("\n");
    case "orchestrator":
      return [
        "Orchestrator produced a worker topology:",
        "- Split work into bounded responsibilities",
        "- Identify dependencies, handoffs, and approval checkpoints",
      ].join("\n");
    case "security-reviewer":
      return [
        "Security reviewer noted risks:",
        "- Check for secret exposure, injection, path traversal, and approval bypasses",
        "- Prioritize exploitable findings with exact evidence",
      ].join("\n");
    case "build-error-resolver":
      return [
        "Build-error resolver proposed diagnostics:",
        "- Start from the first real build/type/test failure",
        "- Verify the smallest corrective change with a targeted command",
      ].join("\n");
    case "refactor-cleaner":
      return [
        "Refactor cleaner summarized safe cleanup:",
        "- Preserve behavior and keep changes reviewable",
        "- Remove dead code only with evidence",
      ].join("\n");
    case "performance-reviewer":
      return [
        "Performance reviewer noted hotspots:",
        "- Inspect allocations, latency, repeated work, and hot-path regressions",
        "- Recommend benchmarks or focused measurements where useful",
      ].join("\n");
    case "documenter":
      return [
        "Documenter summarized HTML report output:",
        "- Synthesize previous worker handoffs and artifacts",
        "- Propose a complete self-contained HTML file through approval",
      ].join("\n");
    default:
      return `Unknown worker role`;
  }
};

const lifecycleBody = (
  lifecycle: WorkerLifecycleInterruption,
  output: string,
): string => {
  const lines = [
    lifecycle.message,
    lifecycle.kind === "requires_input"
      ? "Remote worker paused because it requested input. Harness will not ask the user; retry/backflow must continue from assumptions."
      : "Remote worker paused because it requires authentication setup.",
  ];
  if (output.trim().length > 0) {
    lines.push("", output.trim());
  }
  return lines.join("\n");
};

const composeWorkerUserRequest = (input: {
  originalUserRequest: string;
  stepInstruction: string;
  allowedActions?: readonly string[];
  outputContract?: string;
}): string => {
  const original = input.originalUserRequest.trim();
  const instruction = input.stepInstruction.trim();
  const base =
    original.length === 0
      ? instruction
      : instruction.length === 0 || instruction === original
        ? original
        : [
            "ORIGINAL USER REQUEST",
            original,
            "",
            "PIPELINE STEP INSTRUCTION",
            instruction,
          ].join("\n");
  const allowedActions = input.allowedActions
    ? input.allowedActions.join(", ") || "(none)"
    : "(legacy default)";
  const outputContract = input.outputContract ?? "(unspecified)";
  return [
    base,
    "",
    "WORKER OUTPUT CONTRACT",
    `outputContract: ${outputContract}`,
    `allowedActions: ${allowedActions}`,
    "- A file_patch proposal is allowed only when allowedActions includes file_patch.",
    "- file_patch.patch must be a single-file unified diff for the target file.",
    "- Prefer full hunk headers like @@ -10,3 +10,4 @@; bare @@ headers are allowed only when Harness can uniquely match context.",
    "- Prefer file_patch for partial edits to existing files.",
    "- A file_write proposal is allowed only when allowedActions includes file_write.",
    "- Use file_write only for new files or complete file replacement; file_write.after must be the complete replacement content for the target file.",
    "- Do not put natural-language edit instructions inside file_write.after.",
    "- Do not answer that direct modification is impossible when an allowed action can express the change.",
    "- For requested code changes, emit proposedActions using the allowed action types so Harness can create approvals.",
    "- A prose sentence such as \"I propose file_patch\" is not an approval; include the actual proposedActions entry with path, patch, and rationale.",
    "",
    "STRUCTURED HANDOFF CONTRACT",
    `- Optionally end the response with at most one fenced JSON block tagged \`${WORKER_HANDOFF_FENCE}\` for downstream worker context.`,
    `- Harness accepts proposedActions from either \`harness_agent_plan\` or \`${WORKER_HANDOFF_FENCE}\`; do not leave proposedActions only in prose.`,
    "- This handoff block is for downstream Harness workers; it does not authorize side effects.",
    "- Keep producer.taskRunId/planId/stepId/artifactId as placeholders if unknown; Harness overwrites producer identity.",
    "- Required fields: schemaVersion, status, outputContract, producer, summary, evidence, findings, proposedActions, changedFiles, verification, risks, nextActions.",
    "- findings[].basis must be one of evidence, inference, uncertainty.",
  ].join("\n");
};

const roleToActionIntent = (role: WorkerRole): string => {
  // None of the deterministic roles request side effects; this mapping
  // exists so tests can simulate a misbehaving worker by extending the
  // policy.
  switch (role) {
    case "planner":
    case "coder":
    case "reviewer":
    case "tester":
    case "orchestrator":
    case "security-reviewer":
    case "build-error-resolver":
    case "refactor-cleaner":
    case "performance-reviewer":
    case "documenter":
      return "summarize";
    default:
      return "summarize";
  }
};

const toProposedActionDetails = (
  raw: AgentProposedAction,
): ProposedActionDetails => {
  if (raw.type === "file_write") {
    return {
      type: "file_write",
      filePatch: {
        path: raw.path,
        after: raw.after,
        ...(raw.before !== undefined ? { before: raw.before } : {}),
      },
    };
  }
  if (raw.type === "file_patch") {
    return {
      type: "file_patch",
      unifiedPatch: {
        path: raw.path,
        patch: raw.patch,
      },
    };
  }
  return {
    type: "shell",
    command: raw.command,
    ...(raw.args !== undefined ? { args: raw.args } : {}),
  };
};

const extractStructuredHandoffProposedActions = (
  output: string,
): AgentProposedAction[] => {
  const parsed = parseWorkerHandoffPayload(output);
  return parsed.ok ? [...parsed.payload.proposedActions] : [];
};

const mergeProposedActions = (
  primary: readonly AgentProposedAction[],
  secondary: readonly AgentProposedAction[],
): AgentProposedAction[] => {
  const merged: AgentProposedAction[] = [];
  const seen = new Set<string>();
  for (const action of [...primary, ...secondary]) {
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
  }
  return merged;
};

const resolveHandoffsForStep = (
  dependencyIds: readonly string[],
  handoffsByStepId: ReadonlyMap<string, InternalAgentMessage>,
): InternalAgentMessage[] => {
  return dependencyIds
    .map((stepId) => handoffsByStepId.get(stepId))
    .filter(
      (message): message is InternalAgentMessage => message !== undefined,
    );
};

const shortRationale = (
  action: AgentProposedAction,
  workerTitle: string,
): string => {
  const head =
    action.type === "file_write"
      ? `file_write ${action.path}`
      : action.type === "file_patch"
        ? `file_patch ${action.path}`
      : `shell ${action.command.slice(0, 80)}`;
  return `${workerTitle}: ${head} — ${action.rationale.slice(0, 160)}`;
};

const isUnresolvedApprovalStatus = (status: Approval["status"]): boolean =>
  status === "pending" ||
  status === "approved" ||
  status === "always_approved_for_run";

const latestWorkerArtifactForStep = (
  artifacts: readonly Artifact[],
  planId: string,
  stepId: string,
): Artifact | null => {
  const uri = `harness:orchestration/${planId}/${stepId}`;
  return (
    artifacts
      .filter((artifact) => artifact.kind === "log" && artifact.uri === uri)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? null
  );
};
