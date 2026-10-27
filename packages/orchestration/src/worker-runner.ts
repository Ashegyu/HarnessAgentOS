import type { LocalStateService } from "@harness/storage";
import {
  taskContractFor,
  taskContractBlocksAction,
  validateProposedActionDetails,
  type A2AEndpoint,
  type A2ARegistryEntry,
  type AgentProfile,
  type AgentProposedAction,
  type Artifact,
  type Approval,
  type ProposedActionDetails,
  type Step,
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
import { assertWorkerTaskEntry, isWorkerTaskActive, setActiveWorkerTaskStatus } from "./worker-task-state.ts";

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
  completedPlanStepIds: Set<string>;
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
  needsContinuation?: boolean;
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

    if (input.approval.taskRunId !== input.plan.taskRunId) {
      throw new OrchestrationError("ORCH_APPROVAL_TASK_MISMATCH", "승인과 파이프라인의 작업 ID가 일치하지 않습니다.");
    }
    const taskRun = await this.deps.state.getTaskRun(input.approval.taskRunId);
    assertWorkerTaskEntry(taskRun);
    if (!isWorkerTaskActive(taskRun)) {
      return {
        planId: input.plan.id,
        taskRunId: input.plan.taskRunId,
        workerStepArtifactIds: [],
        workerSteps: [],
        proposedApprovalIds: [],
        ...(taskRun?.status === "paused" ? { needsContinuation: true } : {}),
      };
    }
    if (taskRun && taskContractBlocksAction(taskContractFor(taskRun), "orchestration_plan")) {
      throw new OrchestrationError(
        "TASK_CONTRACT_ACTION_BLOCKED",
        "읽기 전용 작업은 일반 채팅으로 실행하세요. 파이프라인의 외부 작업은 허용되지 않습니다.",
      );
    }
    const priorAttempts = await this.deps.state.pipelineBackflows.listByTaskRun(input.plan.taskRunId);
    const failedRepair = priorAttempts.find(attempt =>
      attempt.planId === input.plan.id && attempt.trigger === "step_failed" &&
      attempt.status === "failed" && attempt.completedAt !== undefined &&
      !priorAttempts.some(later => later.planId === attempt.planId && later.ruleId === attempt.ruleId &&
        later.trigger === attempt.trigger && later.attemptIndex > attempt.attemptIndex));
    if (failedRepair) {
      await setActiveWorkerTaskStatus(this.deps.state, input.plan.taskRunId, "blocked");
      throw new OrchestrationError("PIPELINE_BACKFLOW_FAILED", "Backflow failed; review the failure before approving a new plan");
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
    const settings = await this.deps.state.getSettings();
    const executionWaves = planWorkerWaves(
      input.plan.workerSteps,
      remoteEntries,
      {
        allowApprovalGatedLocalParallelism:
          settings.agent.codexWorkspaceWrite !== true,
      },
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
    let pendingBackflow = false;
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
      await setActiveWorkerTaskStatus(
        this.deps.state,
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
      result: WorkerStepExecutionResult | null,
    ): Promise<void> => {
      if (!result) return;
      if (await this.isTaskRunCancelled(input.plan.taskRunId)) return;
      if (result.status === "succeeded") {
        const createdApprovalIds = await this.createWorkerActionApprovals({
          plan: input.plan,
          result,
          approvalStepIndex:
            baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
        });
        if (createdApprovalIds.length > 0) approvalStepOffset += 1;
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
      if (!(await this.isTaskRunActive(input.plan.taskRunId))) return true;
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
          completedPlanStepIds,
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
      if (backflow.needsContinuation) {
        pendingBackflow = true;
        return false;
      }
      return !backflow.handled || !backflow.succeeded;
    };

    const suspendedAttempt = await this.loadRunningBackflowAttempt(input.plan, "step_failed");
    if (suspendedAttempt) {
      const rule = input.plan.backflowRules?.find(candidate => candidate.id === suspendedAttempt.ruleId);
      if (!rule) throw new OrchestrationError("PIPELINE_BACKFLOW_RULE_NOT_FOUND", "Cannot resume a backflow without its approved rule");
      const outcome = await this.executeBackflowRule({
        rule, trigger: "step_failed", reason: suspendedAttempt.reason ?? "Resume backflow",
        context: { plan: input.plan, baseStepIndex, handoffDependencyIdsByStepId, handoffsByStepId,
          stepArtifactIds, updatedSteps, latestStatusByStepId, completedPlanStepIds, proposedApprovalIds,
          processWorkerResultSideEffects,
          nextApprovalStepIndex: () => baseStepIndex + input.plan.workerSteps.length + approvalStepOffset },
        failedStepId: rule.retryStepId, runDownstreamAfterRetry: false,
      });
      policyReport.push(...outcome.policyReport);
      lastDbStepId = outcome.lastDbStepId;
      lifecycleInterruption = outcome.lifecycleInterruption;
      pendingBackflow = outcome.needsContinuation === true;
      unresolvedFailure = !outcome.succeeded && !pendingBackflow;
    }

    for (const wave of executionWaves) {
      if (pendingBackflow || unresolvedFailure) break;
      if (!(await this.isTaskRunActive(input.plan.taskRunId))) break;
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
          settings.orchestration.maxParallelWorkers,
          () => this.isTaskRunActive(input.plan.taskRunId),
        );
        for (const result of results) {
          if (!result) continue;
          if (await handleResult(result)) unresolvedFailure = true;
          if (result.acceptedActions.length > 0 && result.status === "succeeded") {
            pausedForWorkerApprovals = true;
          }
        }
      } else {
        for (const prepared of preparedWave) {
          if (!(await this.isTaskRunActive(input.plan.taskRunId))) break;
          const result = await runOne(prepared);
          if (!result) break;
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
      if (unresolvedFailure || pausedForWorkerApprovals || pendingBackflow) break;
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
    const finalTask = await setActiveWorkerTaskStatus(
      this.deps.state,
      input.plan.taskRunId,
      lifecycleInterruption !== null
        ? "paused"
        : unresolvedFailure ||
            input.plan.workerSteps.some(
              (step) => latestStatusByStepId.get(step.id) === "failed",
            )
          ? "blocked"
          : pausedForWorkerApprovals || hasUnresolvedWorkerApprovals || pendingBackflow
            ? "waiting_for_approval"
            : "ready_for_review",
    );
    const needsContinuation =
      pendingBackflow ||
      (finalTask?.status === "paused" && lifecycleInterruption === null) ||
      (pausedForWorkerApprovals &&
        input.plan.workerSteps.some((step) => !completedAfterRun.has(step.id)));

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
    const suspendedAttempt = await this.loadRunningBackflowAttempt(input.plan, "quality_failed");
    const rule = input.plan.backflowRules?.find(
      (candidate) => candidate.id === suspendedAttempt?.ruleId,
    ) ?? input.plan.backflowRules?.find(
      (candidate) => candidate.trigger === "quality_failed",
    );
    if (!rule) return null;
    if (!(await this.isTaskRunActive(input.plan.taskRunId))) return null;

    const stepArtifactIds: string[] = [];
    const updatedSteps: WorkerStep[] = [];
    const policyReport: string[] = [];
    const proposedApprovalIds: string[] = [];
    const handoffsByStepId = new Map<string, InternalAgentMessage>();
    const latestStatusByStepId = new Map<string, WorkerStep["status"]>();
    const completedPlanStepIds = new Set<string>();
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
    await setActiveWorkerTaskStatus(this.deps.state, input.plan.taskRunId, "running");

    const processWorkerResultSideEffects = async (
      result: WorkerStepExecutionResult,
    ): Promise<void> => {
      if (result.status === "succeeded") {
        const createdApprovalIds = await this.createWorkerActionApprovals({
          plan: input.plan,
          result,
          approvalStepIndex:
            baseStepIndex + input.plan.workerSteps.length + approvalStepOffset,
        });
        if (createdApprovalIds.length > 0) approvalStepOffset += 1;
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
        completedPlanStepIds,
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
    const finalTask = await setActiveWorkerTaskStatus(
      this.deps.state,
      input.plan.taskRunId,
      lifecycleInterruption !== null
        ? "paused"
        : !outcome.succeeded && !outcome.needsContinuation
          ? "blocked"
        : hasUnresolvedWorkerApprovals || outcome.needsContinuation
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
      ...(outcome.needsContinuation || (finalTask?.status === "paused" && lifecycleInterruption === null)
        ? { needsContinuation: true } : {}),
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
    if (!(await this.isTaskRunActive(context.plan.taskRunId))) return emptyBackflowOutcome(false);
    const existingAttempt = await this.loadRunningBackflowAttempt(context.plan, input.trigger, rule.id);
    const currentAttemptCount = await this.deps.state.pipelineBackflows.countAttempts({
      taskRunId: context.plan.taskRunId,
      planId: context.plan.id,
      ruleId: rule.id,
      trigger: input.trigger,
    });
    if (!existingAttempt && currentAttemptCount >= rule.maxAttempts) {
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

    const attempt = existingAttempt ?? await this.deps.state.pipelineBackflows.createAttempt({
      taskRunId: context.plan.taskRunId,
      planId: context.plan.id,
      ruleId: rule.id,
      trigger: input.trigger,
      targetStepId: rule.targetStepId,
      retryStepId: rule.retryStepId,
      maxAttempts: rule.maxAttempts,
      reason: input.reason,
    });
    if (!existingAttempt) await this.recordBackflowEvent({
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

    // A repair invalidates its old dependency path and all retry descendants.
    // Only outputs published by this exact attempt can advance that path.
    const downstreamSteps = downstreamStepsAfter(context.plan.workerSteps, retryStep.id);
    const invalidatedStepIds = new Set([...replaySteps, ...downstreamSteps].map(step => step.id));
    const recovered = await this.loadCompletedWorkerHandoffs(context.plan, attempt.id);
    for (const stepId of invalidatedStepIds) {
      context.completedPlanStepIds.delete(stepId);
      context.handoffsByStepId.delete(stepId);
      context.latestStatusByStepId.delete(stepId);
    }
    for (const [stepId, handoff] of recovered) {
      if (!invalidatedStepIds.has(stepId)) continue;
      context.handoffsByStepId.set(stepId, handoff);
      context.latestStatusByStepId.set(stepId, "succeeded");
      context.completedPlanStepIds.add(stepId);
    }

    for (const replayStep of replaySteps) {
      const suspension = await this.suspendBackflowIfNeeded(attempt, context);
      if (suspension) return { ...suspension, policyReport, lastDbStepId };
      if (recovered.has(replayStep.id)) continue;
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
        attemptId: attempt.id,
      });
      if (!result) {
        const suspension = await this.suspendBackflowIfNeeded(attempt, context);
        if (suspension) return { ...suspension, policyReport, lastDbStepId };
        await this.failBackflowAttempt({
          attempt,
          reason: "Backflow stopped because the task was paused or stopped",
          eventPayload: { stepId: replayStep.id },
        });
        return { handled: true, succeeded: false, lifecycleInterruption, policyReport, lastDbStepId };
      }
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
      for (const downstreamStep of downstreamSteps) {
        const suspension = await this.suspendBackflowIfNeeded(attempt, context);
        if (suspension) return { ...suspension, policyReport, lastDbStepId };
        if (recovered.has(downstreamStep.id)) continue;
        const result = await this.runBackflowStep({
          context,
          planStep: downstreamStep,
          attemptId: attempt.id,
        });
        if (!result) {
          const suspension = await this.suspendBackflowIfNeeded(attempt, context);
          if (suspension) return { ...suspension, policyReport, lastDbStepId };
          await this.failBackflowAttempt({
            attempt,
            reason: "Backflow stopped because the task was paused or stopped",
            eventPayload: { stepId: downstreamStep.id },
          });
          return { handled: true, succeeded: false, lifecycleInterruption, policyReport, lastDbStepId };
        }
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

    const suspension = await this.suspendBackflowIfNeeded(attempt, context);
    if (suspension) return { ...suspension, policyReport, lastDbStepId };
    const completedAttempt = await this.deps.state.pipelineBackflows.updateAttempt(attempt.id, {
      status: "succeeded",
      completedAt: new Date().toISOString(),
    });
    if (completedAttempt.status !== "succeeded") {
      const suspension = await this.suspendBackflowIfNeeded(attempt, context);
      if (suspension) return { ...suspension, policyReport, lastDbStepId };
      throw new OrchestrationError("PIPELINE_BACKFLOW_STATE_CONFLICT", "Backflow completion lost ownership of the attempt");
    }
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
    attemptId: string;
    additionalHandoffMessages?: readonly InternalAgentMessage[];
  }): Promise<WorkerStepExecutionResult | null> {
    const prepared = await this.prepareWorkerStep(input.planStep, 0);
    const stepIndex = (
      await this.deps.state.listStepsByTaskRun(input.context.plan.taskRunId)
    ).length;
    return this.runPreparedWorkerStep({
      prepared,
      plan: input.context.plan,
      baseStepIndex: input.context.baseStepIndex,
      backflowAttemptId: input.attemptId,
      stepIndexOverride: stepIndex,
      handoffDependencyIdsByStepId: input.context.handoffDependencyIdsByStepId,
      handoffsByStepId: input.context.handoffsByStepId,
      additionalHandoffMessages: input.additionalHandoffMessages ?? [],
    });
  }

  private async loadRunningBackflowAttempt(
    plan: OrchestrationPlan,
    trigger: PipelineBackflowTrigger,
    ruleId?: string,
  ): Promise<PipelineBackflowAttempt | null> {
    const attempts = await this.deps.state.pipelineBackflows.listByTaskRun(plan.taskRunId);
    return attempts.find(attempt => attempt.planId === plan.id && attempt.trigger === trigger &&
      attempt.status === "running" && (ruleId === undefined || attempt.ruleId === ruleId)) ?? null;
  }

  private async suspendBackflowIfNeeded(
    attempt: PipelineBackflowAttempt,
    context: BackflowExecutionContext,
  ): Promise<BackflowExecutionOutcome | null> {
    const task = await this.deps.state.getTaskRun(context.plan.taskRunId);
    if (task?.status === "paused") return { ...emptyBackflowOutcome(true), needsContinuation: true };
    if (!task || task.status === "cancelled" || task.status === "done") {
      await this.failBackflowAttempt({ attempt, reason: "Backflow stopped because the task ended", eventPayload: {} });
      return emptyBackflowOutcome(true);
    }
    if ((await this.listUnresolvedWorkerActionApprovalIdsForPlan(context.plan)).length > 0) {
      return { ...emptyBackflowOutcome(true), needsContinuation: true };
    }
    return null;
  }

  private appendBackflowResult(
    context: BackflowExecutionContext,
    result: WorkerStepExecutionResult,
  ): void {
    context.stepArtifactIds.push(result.artifactId);
    context.updatedSteps.push({ ...result.planStep, status: result.status });
    context.latestStatusByStepId.set(result.planStep.id, result.status);
    if (result.status === "succeeded") context.completedPlanStepIds.add(result.planStep.id);
    else context.completedPlanStepIds.delete(result.planStep.id);
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
    // A log alone is diagnostic evidence. Publish proposals and completion in
    // one synchronous transaction so recovery never observes a partial batch.
    return this.deps.state.withTransaction((state) => {
      const task = state.getTaskRun(input.plan.taskRunId);
      if (!task || task.status === "cancelled" || task.status === "done") return [];
      if (input.result.acceptedActions.length === 0) {
        state.setStepStatus(input.result.dbStepId, "succeeded", {
          outputSummary: workerCompletionSummary(input.result.artifactId),
        });
        return [];
      }
      const approvalStep = state.createStep({
        taskRunId: input.plan.taskRunId,
        index: input.approvalStepIndex,
        kind: "approval",
        title: `Worker action 승인 대기 — ${input.result.planStep.title}`,
        status: "pending",
        inputSummary: input.result.acceptedActions
          .map((a) => a.details.type)
          .join(","),
      });
      const checkpoint = state.createCheckpoint({
        taskRunId: input.plan.taskRunId,
        stepId: approvalStep.id,
        reason: "before_edit",
        stateRef: JSON.stringify({
          taskRunStatus: "waiting_for_approval",
          currentStepId: approvalStep.id,
          artifactIds: [input.result.artifactId],
          orchestrationPlanId: input.plan.id,
          workerHandoff: input.result.handoff,
        }),
        summary: workerActionCheckpointSummary(input.result.acceptedActions.length),
      });
      const approvalIds: string[] = [];
      for (const { action, details, workerTitle } of input.result.acceptedActions) {
        const approval = state.createApproval({
          taskRunId: input.plan.taskRunId,
          checkpointId: checkpoint.id,
          actionType: details.type,
          actionSummary: shortRationale(action, workerTitle),
          status: "pending",
          proposedAction: details,
        });
        approvalIds.push(approval.id);
      }
      state.setTaskRunCurrentStep(
        input.plan.taskRunId,
        approvalStep.id,
      );
      state.setStepStatus(input.result.dbStepId, "succeeded", {
        outputSummary: workerCompletionSummary(input.result.artifactId),
      });
      return approvalIds;
    });
  }

  private async hasUnresolvedApprovals(input: {
    taskRunId: string;
    approvalIds: readonly string[];
  }): Promise<boolean> {
    if (input.approvalIds.length === 0) return false;
    const approvals = await this.deps.state.listApprovalsByTaskRun(
      input.taskRunId,
    );
    return this.unresolvedRetryApprovalIds(approvals, input.approvalIds).length > 0;
  }

  /** A worker's original proposal keeps ownership of its reviewed retry chain. */
  private unresolvedRetryApprovalIds(approvals: Approval[], sourceIds: readonly string[]): string[] {
    const byId = new Map(approvals.map(approval => [approval.id, approval]));
    const unresolved = new Set<string>();
    for (const sourceId of sourceIds) {
      let current = byId.get(sourceId);
      const seen = new Set<string>();
      while (current?.retryApprovalId && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.retryApprovalId);
      }
      if (!current || seen.has(current.id)) unresolved.add(sourceId);
      else if (isUnresolvedApprovalStatus(current.status) || current.executionState === "running" || current.executionState === "uncertain") {
        unresolved.add(current.id);
      }
    }
    return [...unresolved];
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
    const sourceIds = approvals
      .filter(
        (approval) =>
          checkpointPlanIds.get(approval.checkpointId) === plan.id &&
          approval.actionType !== "orchestration_plan",
      )
      .map((approval) => approval.id);
    return this.unresolvedRetryApprovalIds(approvals, sourceIds);
  }

  private async loadCompletedWorkerHandoffs(
    plan: OrchestrationPlan,
    backflowAttemptId?: string,
  ): Promise<Map<string, InternalAgentMessage>> {
    const [artifacts, steps, checkpoints] = await Promise.all([
      this.deps.state.listArtifactsByTaskRun(plan.taskRunId),
      this.deps.state.listStepsByTaskRun(plan.taskRunId),
      this.deps.state.listCheckpointsByTaskRun(plan.taskRunId),
    ]);
    const stepsById = new Map(steps.map((step) => [step.id, step]));
    const storedHandoffsByArtifactId = new Map<string, InternalAgentMessage>();
    for (const checkpoint of checkpoints) {
      try {
        const stored = JSON.parse(checkpoint.stateRef) as { workerHandoff?: InternalAgentMessage };
        const handoff = stored.workerHandoff;
        if (handoff && handoff.planId === plan.id && handoff.taskRunId === plan.taskRunId &&
            typeof handoff.artifactId === "string" && typeof handoff.content === "string") {
          storedHandoffsByArtifactId.set(handoff.artifactId, handoff);
        }
      } catch {
        // Checkpoints belonging to other domains need no worker metadata.
      }
    }
    const handoffs = new Map<string, InternalAgentMessage>();
    for (const step of plan.workerSteps) {
      const artifact = latestWorkerArtifactForStep(artifacts, plan.id, step.id, stepsById, backflowAttemptId);
      if (!artifact?.stepId || stepsById.get(artifact.stepId)?.status !== "succeeded") continue;
      if (stepsById.get(artifact.stepId)?.outputSummary !== workerCompletionSummary(artifact.id)) {
        throw new OrchestrationError(
          "WORKER_COMPLETION_UNVERIFIED",
          `Worker ${step.title} has legacy completion evidence without an atomic proposal publication marker; review its existing approvals before retrying`,
        );
      }
      const stored = storedHandoffsByArtifactId.get(artifact.id);
      const content = stored?.content ?? workerOutputFromArtifact(artifact.summary ?? "");
      const structuredPayload = stored?.structuredPayload ?? buildWorkerHandoffPayload({
        rawOutput: content,
        producer: {
          taskRunId: plan.taskRunId, planId: plan.id, stepId: step.id,
          role: step.role, title: step.title, artifactId: artifact.id,
        },
        ...(step.outputContract !== undefined ? { outputContract: step.outputContract } : {}),
        // A committed result with accepted actions stores its filtered handoff
        // in the approval checkpoint. Without one, no action passed policy.
        proposedActions: [],
      }).payload;
      handoffs.set(
        step.id,
        createInternalAgentMessage({
          taskRunId: plan.taskRunId,
          planId: plan.id,
          fromStepId: step.id,
          fromRole: step.role,
          fromTitle: step.title,
          content,
          structuredPayload,
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

  private async isTaskRunCancelled(taskRunId: string): Promise<boolean> {
    return (await this.deps.state.getTaskRun(taskRunId))?.status === "cancelled";
  }

  private async isTaskRunActive(taskRunId: string): Promise<boolean> {
    return isWorkerTaskActive(await this.deps.state.getTaskRun(taskRunId));
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
  } | null> {
    assertActionTypeAllowed(roleToActionIntent(step.role));
    const invoker = this.deps.agentPlanning;
    const taskRun = await this.deps.state.getTaskRun(taskRunId);
    if (!isWorkerTaskActive(taskRun)) return null;
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
    backflowAttemptId?: string;
    handoffDependencyIdsByStepId: ReadonlyMap<string, readonly string[]>;
    handoffsByStepId: ReadonlyMap<string, InternalAgentMessage>;
    additionalHandoffMessages?: readonly InternalAgentMessage[];
  }): Promise<WorkerStepExecutionResult | null> {
    const { planStep, executionIndex, profile, remoteEndpoint } =
      input.prepared;
    if (!(await this.isTaskRunActive(input.plan.taskRunId))) return null;
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
    await setActiveWorkerTaskStatus(this.deps.state, input.plan.taskRunId, "running");

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
      if (!outcome) {
        await this.deps.state.setStepStatus(dbStep.id, "skipped", {
          outputSummary: "worker did not start because the task was paused or stopped",
        });
        return null;
      }
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
    if (
      status === "succeeded" &&
      requiresFileActionForDiffProposal(planStep) &&
      !acceptedActions.some(({ details }) => isFileChangeAction(details.type))
    ) {
      status = "failed";
      acceptedActions.length = 0;
      body = [
        body.trimEnd(),
        "",
        "Harness validation failed: diff_proposal worker did not produce a file_write or file_patch approval.",
      ].join("\n");
    }
    if (
      status === "succeeded" &&
      requiresShellActionForTestResult(planStep) &&
      !acceptedActions.some(({ details }) => details.type === "shell")
    ) {
      status = "failed";
      acceptedActions.length = 0;
      body = [
        body.trimEnd(),
        "",
        "Harness validation failed: test_result worker did not produce a shell approval.",
      ].join("\n");
    }

    const artifact = await this.deps.state.createArtifact({
      taskRunId: input.plan.taskRunId,
      stepId: dbStep.id,
      kind: "log",
      title: `Worker output: ${planStep.title}`,
      uri: `harness:orchestration/${input.plan.id}/${planStep.id}` +
        (input.backflowAttemptId ? `/backflow/${input.backflowAttemptId}` : ""),
      summary: formatWorkerStepArtifact({
        step: { ...planStep, status },
        output: body,
        ...(profile ? { profileName: profile.name } : {}),
        ...(remoteEndpoint ? { remoteEndpointName: remoteEndpoint.name } : {}),
      }),
    });
    if (status !== "succeeded") {
      await this.deps.state.setStepStatus(dbStep.id, status, {
        outputSummary: `worker artifact ${artifact.id}`,
      });
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
  concurrencyLimit: number,
  shouldContinue: () => Promise<boolean>,
): Promise<R[]> => {
  let sideEffectQueue: Promise<void> = Promise.resolve();
  const processResult = async (result: R): Promise<void> => {
    const next = sideEffectQueue.then(() => onResult(result));
    sideEffectQueue = next.catch(() => {});
    await next;
  };
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  const runLane = async (): Promise<void> => {
    try {
      while (!failure && nextIndex < items.length) {
        if (!(await shouldContinue())) return;
        // Liveness is asynchronous: another lane may have reserved the final
        // item or failed while this lane was waiting. Claim without an await.
        if (failure || nextIndex >= items.length) return;
        const index = nextIndex++;
        const result = await runOne(items[index]!);
        // Started work still owns its publication even if a sibling failed.
        await processResult(result);
        results[index] = result;
      }
    } catch (error) {
      failure ??= { error };
    }
  };
  const laneCount = Math.min(
    items.length,
    Math.max(1, Math.trunc(concurrencyLimit)),
  );
  await Promise.all(Array.from({ length: laneCount }, () => runLane()));
  await sideEffectQueue;
  if (failure) throw failure.error;
  return results.filter((result): result is R => result !== undefined);
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
    "- When outputContract is diff_proposal and file_write/file_patch is allowed, emit at least one concrete file_write or file_patch proposedAction.",
    "- When outputContract is test_result and shell is allowed, emit at least one concrete shell proposedAction for the narrowest useful verification command.",
    "- Worker-created file_patch/file_write approvals may be auto-approved and executed after validation when worker file automation is enabled; do not describe them as manual-only approval work.",
    "- Avoid prose like \"I will not apply changes directly\"; it creates the wrong UX. Emit concrete Harness actions instead.",
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

const requiresFileActionForDiffProposal = (step: WorkerStep): boolean =>
  step.outputContract === "diff_proposal" &&
  step.allowedActions?.some(isFileChangeAction) === true;

const requiresShellActionForTestResult = (step: WorkerStep): boolean =>
  step.outputContract === "test_result" &&
  step.allowedActions?.includes("shell") === true;

const isFileChangeAction = (type: string): boolean =>
  type === "file_write" || type === "file_patch";

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
  if (raw.type === "file_delete") return { type: "file_delete", fileDelete: { path: raw.path } };
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
      : action.type === "file_patch" || action.type === "file_delete"
        ? `${action.type} ${action.path}`
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
  stepsById?: ReadonlyMap<string, Step>,
  backflowAttemptId?: string,
): Artifact | null => {
  const uri = `harness:orchestration/${planId}/${stepId}`;
  const matches = (artifact: Artifact): boolean => artifact.kind === "log" &&
    (backflowAttemptId !== undefined
      ? artifact.uri === `${uri}/backflow/${backflowAttemptId}`
      : artifact.uri === uri || artifact.uri.startsWith(`${uri}/backflow/`));
  return (
    artifacts
      .filter(matches)
      .sort((a, b) =>
        (stepsById?.get(a.stepId ?? "")?.index ?? -1) - (stepsById?.get(b.stepId ?? "")?.index ?? -1) ||
        a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? null
  );
};

const workerOutputFromArtifact = (summary: string): string => {
  const heading = "## Output (advisory only — no side effects)\n\n";
  const start = summary.indexOf(heading);
  if (start < 0) return summary;
  const footer = "\n\n> 이 출력은 제안일 뿐, file/shell 변경이 필요하면 approval을 별도로 생성해야 합니다.";
  const end = summary.lastIndexOf(footer);
  return summary.slice(start + heading.length, end >= start ? end : undefined);
};

const workerCompletionSummary = (artifactId: string): string =>
  `worker artifact ${artifactId}; proposals committed`;
