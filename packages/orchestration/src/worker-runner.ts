import type { LocalStateService } from "@harness/storage";
import type { Approval } from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationPlan,
  type OrchestrationRunResult,
  type WorkerRole,
  type WorkerStep,
} from "./orchestration-types.ts";
import { assertActionTypeAllowed } from "./orchestration-policy.ts";
import { formatWorkerStepArtifact } from "./orchestration-trace.ts";

/**
 * Phase 7 worker runner. Executes the worker steps of an approved
 * OrchestrationPlan in sequence. Each worker step produces a
 * `log` artifact summarizing what the worker proposed; if the worker
 * suggests a side-effecting action it MUST be persisted as a separate
 * approval — never executed directly here.
 *
 * Phase 7 keeps the worker bodies deterministic so MVP tests stay
 * stable. Real model invocation can replace `runWorkerStepBody` later
 * without changing the surrounding contract.
 */
export interface WorkerRunnerDeps {
  state: LocalStateService;
}

export interface WorkerRunInput {
  approval: Approval;
  plan: OrchestrationPlan;
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
    const baseStepIndex = (
      await this.deps.state.listStepsByTaskRun(input.plan.taskRunId)
    ).length;

    for (let i = 0; i < input.plan.workerSteps.length; i += 1) {
      const planStep = input.plan.workerSteps[i]!;
      const dbStep = await this.deps.state.createStep({
        taskRunId: input.plan.taskRunId,
        index: baseStepIndex + i,
        kind: "summarize",
        title: `Worker[${planStep.role}] ${planStep.title}`,
        status: "running",
        inputSummary: planStep.inputSummary,
      });
      let body: string;
      let status: WorkerStep["status"] = "succeeded";
      try {
        body = runWorkerStepBody(planStep);
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
        }),
      });
      stepArtifactIds.push(artifact.id);
      await this.deps.state.setStepStatus(dbStep.id, status, {
        outputSummary: `worker artifact ${artifact.id}`,
      });
      updatedSteps.push({ ...planStep, status });
      if (status === "failed") break;
    }

    return {
      planId: input.plan.id,
      taskRunId: input.plan.taskRunId,
      workerStepArtifactIds: stepArtifactIds,
      workerSteps: updatedSteps,
      proposedApprovalIds: [],
    };
  }
}

const runWorkerStepBody = (step: WorkerStep): string => {
  // Phase 7 deterministic worker. If a worker were to "propose" a
  // side-effecting action, the runner must reject it — that's the
  // policy boundary. Here we hard-fail any forbidden role intent so
  // tests can verify policy enforcement.
  assertActionTypeAllowed(roleToActionIntent(step.role));
  switch (step.role) {
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
    default:
      return `Unknown worker role`;
  }
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
      return "summarize";
    default:
      return "summarize";
  }
};
