import { newId, type LocalStateService } from "@harness/storage";
import type {
  AgentPipeline,
  AgentProfile,
  Approval,
  Artifact,
  WorkerBackflowRule,
  WorkerOutputContract,
  WorkerRole,
} from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationDraftInput,
  type OrchestrationPlan,
  type WorkerStep,
} from "./orchestration-types.ts";
import { formatPlanSummary } from "./orchestration-trace.ts";
import {
  validatePlanShape,
  validateWorkerTopology,
  validateWorkerStep,
} from "./orchestration-policy.ts";

/**
 * Phase 7 planner. Drafts a deterministic OrchestrationPlan and stores
 * it as an `orchestration_plan` artifact alongside a `before_orchestration`
 * checkpoint and a single approval (action_type=orchestration_plan).
 *
 * The plan does NOT execute anything — that is the worker-runner's
 * job, gated by approval.
 */
export interface OrchestrationPlannerDeps {
  state: LocalStateService;
}

export interface DraftedOrchestration {
  plan: OrchestrationPlan;
  artifact: Artifact;
  approval: Approval;
}

export class OrchestrationPlanner {
  private readonly deps: OrchestrationPlannerDeps;

  constructor(deps: OrchestrationPlannerDeps) {

    this.deps = deps;

  }

  async draftPlan(input: OrchestrationDraftInput): Promise<DraftedOrchestration> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new OrchestrationError(
        "ORCH_TASK_NOT_FOUND",
        `TaskRun ${input.taskRunId} not found`,
      );
    }

    // pipelineId path takes precedence; otherwise fall back to the
    // hardcoded mode-driven synthesizer. When pipelineId is set, the
    // mode-vs-step-count constraints don't apply (the pipeline author
    // chose the step count); each step's shape is still validated.
    let workerSteps: WorkerStep[];
    let backflowRules: WorkerBackflowRule[] = [];
    if (input.pipelineId) {
      const synthesized = await this.synthesizeFromPipeline(input.pipelineId);
      workerSteps = synthesized.workerSteps;
      backflowRules = synthesized.backflowRules;
      for (const step of workerSteps) validateWorkerStep(step);
      validateWorkerTopology(workerSteps);
    } else {
      workerSteps = synthesizeWorkerSteps(input.mode, taskRun.userRequest);
      validatePlanShape({ mode: input.mode, workerSteps });
    }

    const planId = newId("learningTrace");
    const stepIndex = (
      await this.deps.state.listStepsByTaskRun(taskRun.id)
    ).length;
    const planStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex,
      kind: "plan",
      title: `Orchestration plan (${input.mode})`,
      status: "running",
      inputSummary: input.instruction?.slice(0, 200) ?? "",
    });
    const markdown = formatPlanSummary({
      mode: input.mode,
      workerSteps,
      ...(backflowRules.length > 0 ? { backflowRules } : {}),
      ...(input.instruction !== undefined
        ? { instruction: input.instruction }
        : {}),
    });
    const planJson = JSON.stringify({
      id: planId,
      mode: input.mode,
      workerSteps,
      ...(backflowRules.length > 0 ? { backflowRules } : {}),
      ...(input.pipelineId !== undefined
        ? { sourcePipelineId: input.pipelineId }
        : {}),
    });
    // Summary embeds both the human-readable markdown AND a fenced JSON
    // block so the worker-runner can recover the exact plan (including
    // step ids) without an extra schema column.
    const summary = `${markdown}\n\n<!-- orchestration-plan:json -->\n\`\`\`json\n${planJson}\n\`\`\`\n`;
    const artifact = await this.deps.state.createArtifact({
      taskRunId: taskRun.id,
      stepId: planStep.id,
      kind: "orchestration_plan",
      title: `Orchestration plan ${input.mode}`,
      uri: `harness:orchestration/${taskRun.id}/${planId}`,
      summary,
    });
    await this.deps.state.setStepStatus(planStep.id, "succeeded", {
      outputSummary: `orchestration_plan artifact ${artifact.id}`,
    });

    const approvalStep = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: stepIndex + 1,
      kind: "approval",
      title: "Orchestration plan 승인 대기",
      status: "pending",
      inputSummary: input.mode,
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: approvalStep.id,
      reason: "before_edit",
      stateRef: JSON.stringify({
        taskRunStatus: taskRun.status,
        currentStepId: approvalStep.id,
        artifactIds: [artifact.id],
        orchestrationPlanId: planId,
        mode: input.mode,
      }),
      summary: `before_orchestration checkpoint for ${input.mode}`,
    });
    const approval = await this.deps.state.createApproval({
      taskRunId: taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "orchestration_plan",
      actionSummary: `Run ${input.mode} orchestration with ${workerSteps.length} worker step(s)`,
      status: "pending",
    });

    const plan: OrchestrationPlan = {
      id: planId,
      taskRunId: taskRun.id,
      mode: input.mode,
      workerSteps,
      requiresApproval: true,
      ...(input.pipelineId !== undefined
        ? { sourcePipelineId: input.pipelineId }
        : {}),
      ...(backflowRules.length > 0 ? { backflowRules } : {}),
    };
    return { plan, artifact, approval };
  }

  /**
   * Expand an AgentPipeline into WorkerStep[]. Fails fast if the
   * pipeline is unknown or any step references a profile that was
   * deleted since the pipeline was authored — orchestration must never
   * silently fall back, since the missing persona/permissions would
   * change the run's behavior.
   */
  private async synthesizeFromPipeline(
    pipelineId: string,
  ): Promise<{
    workerSteps: WorkerStep[];
    backflowRules: WorkerBackflowRule[];
  }> {
    const pipeline: AgentPipeline | null =
      await this.deps.state.agentPipelines.get(pipelineId);
    if (!pipeline) {
      throw new OrchestrationError(
        "PIPELINE_NOT_FOUND",
        `AgentPipeline ${pipelineId} not found`,
      );
    }
    const out: WorkerStep[] = [];
    const workerIdByPipelineStepId = new Map(
      pipeline.steps.map((step) => [step.id, newId("step")] as const),
    );
    for (const [index, step] of pipeline.steps.entries()) {
      const profile: AgentProfile | null =
        await this.deps.state.agentProfiles.get(step.agentProfileId);
      if (!profile) {
        throw new OrchestrationError(
          "PIPELINE_REFERENCED_PROFILE_MISSING",
          `AgentPipeline ${pipeline.name} step "${step.title}" references missing profile ${step.agentProfileId}`,
        );
      }
      let remoteEndpointId: string | undefined;
      if (step.remoteEndpointId !== undefined) {
        const endpoint = await this.deps.state.a2aRemoteAgents.getEndpoint(
          step.remoteEndpointId,
        );
        if (!endpoint) {
          throw new OrchestrationError(
            "PIPELINE_REFERENCED_REMOTE_ENDPOINT_MISSING",
            `AgentPipeline ${pipeline.name} step "${step.title}" references missing remote endpoint ${step.remoteEndpointId}`,
          );
        }
        if (!endpoint.enabled || !endpoint.trusted) {
          throw new OrchestrationError(
            "PIPELINE_REMOTE_ENDPOINT_UNAVAILABLE",
            `AgentPipeline ${pipeline.name} step "${step.title}" references unavailable remote endpoint ${step.remoteEndpointId}`,
          );
        }
        remoteEndpointId = endpoint.id;
      }
      const role = profile.role as WorkerRole;
      const workerStepId = workerIdByPipelineStepId.get(step.id)!;
      const defaultDependsOn =
        index > 0 ? [pipeline.steps[index - 1]!.id] : [];
      const sourceDependsOn =
        step.dependsOn === undefined ? defaultDependsOn : step.dependsOn;
      const dependsOn = sourceDependsOn.map(
        (depId) => workerIdByPipelineStepId.get(depId)!,
      );
      const outputContract: WorkerOutputContract =
        step.outputContract ?? defaultOutputContractForRole(role);
      out.push({
        id: workerStepId,
        title: step.title,
        role,
        inputSummary: step.instruction.slice(0, 120),
        // Preserve the full instruction so the runner can pass it
        // verbatim to the CLI; only the display summary is truncated.
        instruction: step.instruction,
        expectedArtifactKinds: [...step.expectedArtifactKinds],
        status: "pending",
        agentProfileId: step.agentProfileId,
        ...(remoteEndpointId !== undefined ? { remoteEndpointId } : {}),
        ...(dependsOn.length > 0 || step.dependsOn !== undefined
          ? { dependsOn }
          : {}),
        ...(step.allowedActions !== undefined
          ? { allowedActions: [...step.allowedActions] }
          : {}),
        outputContract,
      });
    }
    const backflowRules = (pipeline.backflowRules ?? []).map((rule) => ({
      ...rule,
      targetStepId: workerIdByPipelineStepId.get(rule.targetStepId)!,
      retryStepId: workerIdByPipelineStepId.get(rule.retryStepId)!,
    }));
    return { workerSteps: out, backflowRules };
  }
}

const synthesizeWorkerSteps = (
  mode: OrchestrationDraftInput["mode"],
  userRequest: string,
): WorkerStep[] => {
  const summary = userRequest.slice(0, 120);
  // Legacy mode-driven plans share the same userRequest for every step —
  // the deterministic stub never used the value but Phase 2 CLI workers
  // (when injected) treat instruction as the agent's userRequest.
  const base = {
    inputSummary: summary,
    instruction: userRequest,
    expectedArtifactKinds: ["log", "plan"] as string[],
    status: "pending" as const,
  };
  switch (mode) {
    case "single_worker":
      return [
        {
          id: newId("step"),
          title: "단일 워커가 요청을 분석하고 결과 요약을 작성",
          role: "coder",
          outputContract: defaultOutputContractForRole("coder"),
          ...base,
        },
      ];
    case "planner_worker":
      return [
        {
          id: newId("step"),
          title: "Planner가 단계별 계획을 작성",
          role: "planner",
          outputContract: defaultOutputContractForRole("planner"),
          ...base,
        },
        {
          id: newId("step"),
          title: "Worker가 계획을 검토하고 결과 요약을 작성",
          role: "coder",
          outputContract: defaultOutputContractForRole("coder"),
          ...base,
        },
      ];
    case "multi_worker":
      return [
        {
          id: newId("step"),
          title: "Planner가 단계별 계획을 작성",
          role: "planner",
          outputContract: defaultOutputContractForRole("planner"),
          ...base,
        },
        {
          id: newId("step"),
          title: "Coder가 변경 영역과 영향 범위를 정리",
          role: "coder",
          outputContract: defaultOutputContractForRole("coder"),
          ...base,
        },
        {
          id: newId("step"),
          title: "Reviewer가 위험과 누락된 검증을 점검",
          role: "reviewer",
          outputContract: defaultOutputContractForRole("reviewer"),
          ...base,
        },
        {
          id: newId("step"),
          title: "Tester가 필요한 테스트 후보를 제안",
          role: "tester",
          outputContract: defaultOutputContractForRole("tester"),
          ...base,
        },
      ];
    default:
      throw new OrchestrationError(
        "ORCH_INVALID_PLAN",
        `Unknown orchestration mode ${mode}`,
      );
  }
};

const defaultOutputContractForRole = (
  role: WorkerRole,
): WorkerOutputContract => {
  switch (role) {
    case "planner":
    case "orchestrator":
      return "plan";
    case "coder":
    case "refactor-cleaner":
      return "diff_proposal";
    case "reviewer":
    case "security-reviewer":
    case "performance-reviewer":
      return "review";
    case "tester":
    case "build-error-resolver":
      return "test_result";
    default:
      return "review";
  }
};
