import { newId, type LocalStateService } from "@harness/storage";
import type { Approval, Artifact } from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationDraftInput,
  type OrchestrationPlan,
  type WorkerStep,
} from "./orchestration-types.ts";
import { formatPlanSummary } from "./orchestration-trace.ts";
import { validatePlanShape } from "./orchestration-policy.ts";

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

    const workerSteps = synthesizeWorkerSteps(input.mode, taskRun.userRequest);
    validatePlanShape({ mode: input.mode, workerSteps });

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
      ...(input.instruction !== undefined
        ? { instruction: input.instruction }
        : {}),
    });
    const planJson = JSON.stringify({
      id: planId,
      mode: input.mode,
      workerSteps,
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
    };
    return { plan, artifact, approval };
  }
}

const synthesizeWorkerSteps = (
  mode: OrchestrationDraftInput["mode"],
  userRequest: string,
): WorkerStep[] => {
  const summary = userRequest.slice(0, 120);
  const base = {
    inputSummary: summary,
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
          ...base,
        },
      ];
    case "planner_worker":
      return [
        {
          id: newId("step"),
          title: "Planner가 단계별 계획을 작성",
          role: "planner",
          ...base,
        },
        {
          id: newId("step"),
          title: "Worker가 계획을 검토하고 결과 요약을 작성",
          role: "coder",
          ...base,
        },
      ];
    case "multi_worker":
      return [
        {
          id: newId("step"),
          title: "Planner가 단계별 계획을 작성",
          role: "planner",
          ...base,
        },
        {
          id: newId("step"),
          title: "Coder가 변경 영역과 영향 범위를 정리",
          role: "coder",
          ...base,
        },
        {
          id: newId("step"),
          title: "Reviewer가 위험과 누락된 검증을 점검",
          role: "reviewer",
          ...base,
        },
        {
          id: newId("step"),
          title: "Tester가 필요한 테스트 후보를 제안",
          role: "tester",
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
