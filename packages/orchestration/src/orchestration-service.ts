import type { LocalStateService } from "@harness/storage";
import {
  diagnosticErrorCode,
  diagnosticErrorMessage,
  evaluateApprovalActionPolicy,
  formatDiagnosticLog,
  type Approval,
} from "@harness/core";
import {
  OrchestrationError,
  type OrchestrationDraftInput,
  type OrchestrationPlan,
  type OrchestrationRunResult,
} from "./orchestration-types.ts";
import {
  OrchestrationPlanner,
  type DraftedOrchestration,
} from "./orchestration-planner.ts";
import { WorkerRunner, type WorkerCliInvoker } from "./worker-runner.ts";

/**
 * Phase 7 service. Wraps the planner + runner with plan recovery so the
 * IPC handler stays small. `enabled=false` (the default per phase-07
 * spec) makes draftPlan and runApproved refuse with a clear error so
 * the basic Harness flow stays unaffected.
 */
export interface OrchestrationServiceDeps {
  state: LocalStateService;
  /**
   * Feature flag. Defaults to false at MVP per phase-07 spec
   * ("Phase 7에서도 feature flag 기본값은 off다"). Sync getter so
   * live settings changes propagate without service recreation.
   */
  enabled: () => boolean;
  /**
   * Phase 2 CLI invoker. When provided, pipeline-driven worker steps
   * run their bound AgentProfile through the real CLI instead of the
   * deterministic stub. Omitted in tests and legacy environments so
   * the existing contract stays intact.
   */
  agentPlanning?: WorkerCliInvoker;
  onTaskRunChanged?: (taskRunId: string) => void | Promise<void>;
}

export class OrchestrationService {
  private readonly planner: OrchestrationPlanner;
  private readonly worker: WorkerRunner;
  private readonly deps: OrchestrationServiceDeps;
  constructor(deps: OrchestrationServiceDeps) {
    this.deps = deps;
    this.planner = new OrchestrationPlanner({ state: deps.state });
    this.worker = new WorkerRunner({
      state: deps.state,
      ...(deps.agentPlanning ? { agentPlanning: deps.agentPlanning } : {}),
      ...(deps.onTaskRunChanged
        ? { onTaskRunChanged: deps.onTaskRunChanged }
        : {}),
    });
  }

  isEnabled(): boolean {
    return this.deps.enabled();
  }

  async draftPlan(input: OrchestrationDraftInput): Promise<DraftedOrchestration> {
    this.assertEnabled();
    try {
      return await this.planner.draftPlan(input);
    } catch (e) {
      await this.writeDiagnosticLog({
        taskRunId: input.taskRunId,
        phase: "orchestration.draftPlan",
        error: e,
      });
      await this.markTaskBlocked(input.taskRunId);
      throw e;
    }
  }

  async runApproved(input: {
    approvalId: string;
  }): Promise<OrchestrationRunResult> {
    this.assertEnabled();
    const approval = await this.deps.state.getApproval(input.approvalId);
    if (!approval) {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_REQUIRED",
        `Approval ${input.approvalId} not found`,
      );
    }
    if (approval.actionType !== "orchestration_plan") {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_TYPE_MISMATCH",
        `Approval ${input.approvalId} is not for an orchestration plan`,
      );
    }
    if (
      approval.status !== "approved" &&
      approval.status !== "always_approved_for_run"
    ) {
      throw new OrchestrationError(
        "ORCHESTRATION_APPROVAL_REQUIRED",
        `Approval ${input.approvalId} is ${approval.status}`,
      );
    }
    const policy =
      approval.policyEvaluation ?? evaluateApprovalActionPolicy(approval.actionType);
    if (policy.decision === "blocked") {
      throw new OrchestrationError(
        "ORCHESTRATION_POLICY_BLOCKED",
        `Policy blocked orchestration approval ${approval.id}: ${policy.reason}`,
      );
    }
    const plan = await this.recoverPlan(approval);
    const approvalStepId = await this.markApprovalExecutionStarted(approval);
    let result: OrchestrationRunResult;
    try {
      result = await this.worker.runApproved({ approval, plan });
    } catch (e) {
      await this.writeDiagnosticLog({
        taskRunId: approval.taskRunId,
        stepId: approvalStepId,
        approvalId: approval.id,
        phase: "orchestration.runApproved",
        error: e,
      });
      await this.markTaskBlocked(approval.taskRunId);
      throw e;
    }
    try {
      await this.deps.state.decideApproval(
        input.approvalId,
        "executed",
        `Worker ${result.workerSteps.length}개 완료 — Artifacts 탭에서 결과 확인`,
      );
    } catch {
      // non-fatal: status update is best-effort
    }
    return result;
  }

  private async markApprovalExecutionStarted(
    approval: Approval,
  ): Promise<string | undefined> {
    const checkpoints = await this.deps.state.listCheckpointsByTaskRun(
      approval.taskRunId,
    );
    const checkpoint = checkpoints.find((c) => c.id === approval.checkpointId);
    if (checkpoint) {
      await this.deps.state.setStepStatus(checkpoint.stepId, "succeeded", {
        outputSummary: "orchestration plan approved; worker execution started",
      });
    }
    const steps = await this.deps.state.listStepsByTaskRun(approval.taskRunId);
    await Promise.all(
      steps
        .filter(
          (step) =>
            step.title === "Agent plan 대기" && step.status === "pending",
        )
        .map((step) =>
          this.deps.state.setStepStatus(step.id, "skipped", {
            outputSummary: "skipped because orchestration pipeline owns this run",
          }),
        ),
    );
    await this.deps.state.setTaskRunStatus(approval.taskRunId, "running");
    return checkpoint?.stepId;
  }

  private async markTaskBlocked(taskRunId: string): Promise<void> {
    try {
      await this.deps.state.setTaskRunStatus(taskRunId, "blocked");
    } catch {
      // non-fatal: the original worker error is more useful to callers
    }
  }

  private async writeDiagnosticLog(input: {
    taskRunId: string;
    stepId?: string;
    approvalId?: string;
    phase: string;
    error: unknown;
  }): Promise<void> {
    try {
      const errorCode = diagnosticErrorCode(
        input.error,
        "ORCHESTRATION_ERROR",
      );
      const message = diagnosticErrorMessage(input.error);
      await this.deps.state.createArtifact({
        taskRunId: input.taskRunId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        kind: "log",
        title: `Diagnostic: ${input.phase}`,
        uri: `harness:diagnostic/${input.taskRunId}/${Date.now()}`,
        summary: formatDiagnosticLog({
          severity: "error",
          subsystem: "orchestration",
          phase: input.phase,
          taskRunId: input.taskRunId,
          ...(input.stepId ? { stepId: input.stepId } : {}),
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          errorCode,
          message,
        }),
      });
    } catch {
      // Logging is diagnostic only; never hide the original failure.
    }
  }

  /**
   * Recover the most recent orchestration plan attached to a TaskRun
   * (used by the IPC handler to render OrchestrationPanel state).
   */
  async getLatestPlan(input: {
    taskRunId: string;
  }): Promise<OrchestrationPlan | null> {
    const artifacts = await this.deps.state.listArtifactsByTaskRun(
      input.taskRunId,
    );
    const planArtifacts = artifacts.filter(
      (a) => a.kind === "orchestration_plan",
    );
    if (planArtifacts.length === 0) return null;
    const newest = planArtifacts[planArtifacts.length - 1]!;
    const plan = parseEmbeddedPlanJson(newest.summary ?? "");
    if (!plan) return null;
    return {
      id: plan.id,
      taskRunId: input.taskRunId,
      mode: plan.mode,
      workerSteps: plan.workerSteps,
      requiresApproval: true,
      ...(plan.sourcePipelineId !== undefined
        ? { sourcePipelineId: plan.sourcePipelineId }
        : {}),
      ...(plan.sourceHarness !== undefined
        ? { sourceHarness: plan.sourceHarness }
        : {}),
      ...(plan.backflowRules !== undefined
        ? { backflowRules: plan.backflowRules }
        : {}),
    };
  }

  private async recoverPlan(approval: Approval): Promise<OrchestrationPlan> {
    const checkpoints = await this.deps.state.listCheckpointsByTaskRun(
      approval.taskRunId,
    );
    const checkpoint = checkpoints.find((c) => c.id === approval.checkpointId);
    let artifactIds: string[] = [];
    if (checkpoint) {
      try {
        const parsed = JSON.parse(checkpoint.stateRef) as {
          artifactIds?: string[];
        };
        artifactIds = parsed.artifactIds ?? [];
      } catch {
        artifactIds = [];
      }
    }
    const artifacts = await this.deps.state.listArtifactsByTaskRun(
      approval.taskRunId,
    );
    const planArtifact =
      artifacts.find(
        (a) => a.kind === "orchestration_plan" && artifactIds.includes(a.id),
      ) ?? artifacts.find((a) => a.kind === "orchestration_plan");
    if (!planArtifact) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Could not locate orchestration_plan artifact for approval ${approval.id}`,
      );
    }
    const parsed = parseEmbeddedPlanJson(planArtifact.summary ?? "");
    if (!parsed) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Plan artifact ${planArtifact.id} has no embedded JSON`,
      );
    }
    return {
      id: parsed.id,
      taskRunId: approval.taskRunId,
      mode: parsed.mode,
      workerSteps: parsed.workerSteps,
      requiresApproval: true,
      ...(parsed.sourcePipelineId !== undefined
        ? { sourcePipelineId: parsed.sourcePipelineId }
        : {}),
      ...(parsed.sourceHarness !== undefined
        ? { sourceHarness: parsed.sourceHarness }
        : {}),
      ...(parsed.backflowRules !== undefined
        ? { backflowRules: parsed.backflowRules }
        : {}),
    };
  }

  private assertEnabled(): void {
    if (!this.deps.enabled()) {
      throw new OrchestrationError(
        "ORCHESTRATION_DISABLED",
        "Agent orchestration is disabled. Enable the feature flag to use it.",
      );
    }
  }
}

const planJsonRe = /```json\s*([\s\S]+?)\s*```/;
const parseEmbeddedPlanJson = (
  summary: string,
):
  | {
      id: string;
      mode: OrchestrationPlan["mode"];
      workerSteps: OrchestrationPlan["workerSteps"];
      sourcePipelineId?: string;
      sourceHarness?: OrchestrationPlan["sourceHarness"];
      backflowRules?: OrchestrationPlan["backflowRules"];
    }
  | null => {
  const match = planJsonRe.exec(summary);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1] ?? "") as {
      id: string;
      mode: OrchestrationPlan["mode"];
      workerSteps: OrchestrationPlan["workerSteps"];
      sourcePipelineId?: unknown;
      sourceHarness?: unknown;
      backflowRules?: unknown;
    };
    if (!parsed || !parsed.id || !parsed.mode || !Array.isArray(parsed.workerSteps))
      return null;
    // `sourcePipelineId` is the marker for "this plan was generated
    // from a pipeline template" — the renderer relies on it to know
    // whether the user already consented to auto-run everything when
    // they picked the pipeline at submit time. Drop it cleanly when
    // the persisted payload is missing or shaped wrong rather than
    // crashing the recovery flow.
    const out: {
      id: string;
      mode: OrchestrationPlan["mode"];
      workerSteps: OrchestrationPlan["workerSteps"];
      sourcePipelineId?: string;
      sourceHarness?: OrchestrationPlan["sourceHarness"];
      backflowRules?: OrchestrationPlan["backflowRules"];
    } = {
      id: parsed.id,
      mode: parsed.mode,
      workerSteps: parsed.workerSteps,
    };
    if (
      typeof parsed.sourcePipelineId === "string" &&
      parsed.sourcePipelineId.length > 0
    ) {
      out.sourcePipelineId = parsed.sourcePipelineId;
    }
    if (isSourceHarnessMetadata(parsed.sourceHarness)) {
      out.sourceHarness = parsed.sourceHarness;
    }
    if (Array.isArray(parsed.backflowRules)) {
      out.backflowRules = parsed.backflowRules as OrchestrationPlan["backflowRules"];
    }
    return out;
  } catch {
    return null;
  }
};

const isSourceHarnessMetadata = (
  value: unknown,
): value is OrchestrationPlan["sourceHarness"] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.packageId === "string" &&
    record.packageId.length > 0 &&
    typeof record.packageName === "string" &&
    record.packageName.length > 0 &&
    typeof record.workflowId === "string" &&
    record.workflowId.length > 0 &&
    typeof record.workflowName === "string" &&
    record.workflowName.length > 0 &&
    typeof record.bindingSetId === "string" &&
    record.bindingSetId.length > 0 &&
    typeof record.bindingSetName === "string" &&
    record.bindingSetName.length > 0
  );
};
