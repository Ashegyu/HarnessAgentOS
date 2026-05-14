import type { LocalStateService } from "@harness/storage";
import type { AgentProfile, Approval } from "@harness/core";
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
    profile: AgentProfile;
    userRequest: string;
  }): Promise<{ outputText: string }>;
}

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
      // When the step references a specific AgentProfile (pipeline-driven
      // plans), fail-fast if that profile has been deleted since draft.
      // Falling back to a default profile would silently change the
      // persona/permissions the user approved, so we refuse to run.
      let profile = null;
      if (planStep.agentProfileId) {
        profile = await this.deps.state.agentProfiles.get(
          planStep.agentProfileId,
        );
        if (!profile) {
          throw new OrchestrationError(
            "PIPELINE_REFERENCED_PROFILE_MISSING",
            `Worker step "${planStep.title}" references missing profile ${planStep.agentProfileId}`,
          );
        }
      }
      const dbStep = await this.deps.state.createStep({
        taskRunId: input.plan.taskRunId,
        index: baseStepIndex + i,
        kind: "summarize",
        title: profile
          ? `Worker[${profile.name}] ${planStep.title}`
          : `Worker[${planStep.role}] ${planStep.title}`,
        status: "running",
        inputSummary: planStep.inputSummary,
      });
      let body: string;
      let status: WorkerStep["status"] = "succeeded";
      try {
        body = await this.runWorkerStepBody(
          planStep,
          profile,
          input.plan.taskRunId,
        );
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
  ): Promise<string> {
    assertActionTypeAllowed(roleToActionIntent(step.role));
    const invoker = this.deps.agentPlanning;
    const userRequest = step.instruction ?? step.inputSummary;
    if (invoker && profile && userRequest.length > 0) {
      const { outputText } = await invoker.invokeForWorker({
        taskRunId,
        profile,
        userRequest,
      });
      // Prefix with a small attribution line so the artifact reader
      // sees which profile produced the text. Persona snippet is kept
      // short — full persona is the system prompt the CLI consumed.
      const personaSnippet =
        profile.persona.length > 0
          ? `[${profile.name}] persona: ${profile.persona.slice(0, 140)}\n\n`
          : `[${profile.name}]\n\n`;
      return personaSnippet + outputText;
    }
    // Fallback: deterministic stub.
    const personaLine =
      profile && profile.persona.length > 0
        ? `[${profile.name}] persona: ${profile.persona.slice(0, 140)}\n\n`
        : "";
    return personaLine + roleBody(step.role);
  }
}

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
