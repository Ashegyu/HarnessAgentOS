import type { LocalStateService } from "@harness/storage";
import {
  validateProposedActionDetails,
  type A2AEndpoint,
  type A2ARegistryEntry,
  type AgentProfile,
  type AgentProposedAction,
  type Approval,
  type ProposedActionDetails,
  workerActionCheckpointSummary,
} from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationPlan,
  type OrchestrationRunResult,
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
import { planWorkerWaves } from "./worker-wave-planner.ts";
import { buildEffectiveWorkerDependencyMap } from "./worker-step-dependencies.ts";

/**
 * Minimal CLI invocation contract that the worker-runner depends on.
 * Implemented by `AgentPlanningService.invokeForWorker` in production;
 * tests inject a fake that returns canned text without touching the CLI.
 *
 * Phase 2 policy (a): side-effect-free worker. The implementation MUST
 * NOT execute file_write / shell / dependency_install / git_commit /
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

    for (const wave of executionWaves) {
      const preparedWave = await Promise.all(
        wave.steps.map((planStep) =>
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
      const results = wave.parallelizable
        ? await runParallel(preparedWave, runOne, processWorkerResultSideEffects)
        : await runSerial(preparedWave, runOne, processWorkerResultSideEffects);
      for (const result of results) {
        stepArtifactIds.push(result.artifactId);
        updatedSteps.push({ ...result.planStep, status: result.status });
        lastDbStepId = result.dbStepId;
        if (result.lifecycleInterruption) {
          lifecycleInterruption = result.lifecycleInterruption;
        }
        if (result.handoff) {
          handoffMessages.push(result.handoff);
          handoffsByStepId.set(result.planStep.id, result.handoff);
        }
        policyReport.push(...result.policyReport);
      }
      if (results.some((result) => result.status === "failed")) break;
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
    await this.deps.state.setTaskRunStatus(
      input.plan.taskRunId,
      lifecycleInterruption !== null
        ? "paused"
        : updatedSteps.some((s) => s.status === "failed")
          ? "blocked"
          : hasUnresolvedWorkerApprovals
            ? "waiting_for_approval"
            : "ready_for_review",
    );

    return {
      planId: input.plan.id,
      taskRunId: input.plan.taskRunId,
      workerStepArtifactIds: stepArtifactIds,
      workerSteps: updatedSteps,
      proposedApprovalIds,
    };
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
   *      MUST NOT execute file_write/shell directly.
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
    handoffDependencyIdsByStepId: ReadonlyMap<string, readonly string[]>;
    handoffsByStepId: ReadonlyMap<string, InternalAgentMessage>;
  }): Promise<WorkerStepExecutionResult> {
    const { planStep, executionIndex, profile, remoteEndpoint } =
      input.prepared;
    const dbStep = await this.deps.state.createStep({
      taskRunId: input.plan.taskRunId,
      index: input.baseStepIndex + executionIndex,
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
        ),
      );
      body = outcome.body;
      proposedActions = outcome.proposedActions;
      if (outcome.lifecycle) {
        lifecycleInterruption = outcome.lifecycle;
        body = lifecycleBody(outcome.lifecycle, body);
        status = "failed";
        proposedActions = [];
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

    const handoff =
      status === "succeeded"
        ? createInternalAgentMessage({
            taskRunId: input.plan.taskRunId,
            planId: input.plan.id,
            fromStepId: planStep.id,
            fromRole: planStep.role,
            fromTitle: planStep.title,
            content: body,
            artifactId: artifact.id,
          })
        : null;
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

const runSerial = async <T, R>(
  items: readonly T[],
  runOne: (item: T) => Promise<R>,
  onResult?: (result: R) => Promise<void>,
): Promise<R[]> => {
  const results: R[] = [];
  for (const item of items) {
    const result = await runOne(item);
    await onResult?.(result);
    results.push(result);
    if (
      typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "failed"
    ) {
      break;
    }
  }
  return results;
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
      ? "Remote worker paused because it requires user input."
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
}): string => {
  const original = input.originalUserRequest.trim();
  const instruction = input.stepInstruction.trim();
  if (original.length === 0) return instruction;
  if (instruction.length === 0 || instruction === original) return original;
  return [
    "ORIGINAL USER REQUEST",
    original,
    "",
    "PIPELINE STEP INSTRUCTION",
    instruction,
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
  return {
    type: "shell",
    command: raw.command,
    ...(raw.args !== undefined ? { args: raw.args } : {}),
  };
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
      : `shell ${action.command.slice(0, 80)}`;
  return `${workerTitle}: ${head} — ${action.rationale.slice(0, 160)}`;
};
