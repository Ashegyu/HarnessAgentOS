import type { LocalStateService } from "@harness/storage";
import {
  diagnosticErrorCode,
  diagnosticErrorMessage,
  evaluateApprovalActionPolicy,
  formatDiagnosticLog,
  isWorkerBackflowRule,
  ORCHESTRATION_MODES,
  WORKER_ROLES,
  type Artifact,
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
import { assertWorkerTaskEntry, setActiveWorkerTaskStatus } from "./worker-task-state.ts";
import { orderWorkerStepsByDependencies, validateWorkerStep } from "./orchestration-policy.ts";

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
  private readonly inflight = new Map<string, Promise<OrchestrationRunResult>>();
  private stopping = false;

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inflight.values()]);
  }
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

  runApproved(input: { approvalId: string }): Promise<OrchestrationRunResult> {
    if (this.stopping) return Promise.reject(new Error("APPLICATION_SHUTTING_DOWN"));
    const existing = this.inflight.get(input.approvalId);
    if (existing) return existing;
    const work = this.runApprovedOnce(input).finally(() => this.inflight.delete(input.approvalId));
    this.inflight.set(input.approvalId, work);
    return work;
  }

  private async runApprovedOnce(input: {
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
    assertWorkerTaskEntry(await this.deps.state.getTaskRun(approval.taskRunId));
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
    if (!result.needsContinuation) {
      const failed = result.workerSteps.some(step => step.status === "failed");
      await this.deps.state.decideApproval(
          input.approvalId,
          "executed",
          failed ? "Worker 실행 실패 — 오류와 결과를 확인하세요."
            : `Worker ${result.workerSteps.length}개 실행 종료 — 작업 완료 여부는 검증 후 결정됩니다.`,
        );
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
      // Keep a resume anchor even when Pause wins before the first worker starts.
      await this.deps.state.setTaskRunCurrentStep(approval.taskRunId, checkpoint.stepId);
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
    const task = await setActiveWorkerTaskStatus(this.deps.state, approval.taskRunId, "running");
    assertWorkerTaskEntry(task);
    return checkpoint?.stepId;
  }

  private async markTaskBlocked(taskRunId: string): Promise<void> {
    try {
      await setActiveWorkerTaskStatus(this.deps.state, taskRunId, "blocked");
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
    const plan = parseStoredPlanArtifact(newest, input.taskRunId);
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
    let planId: string | undefined;
    let mode: string | undefined;
    if (checkpoint) {
      try {
        const parsed = JSON.parse(checkpoint.stateRef) as {
          artifactIds?: unknown;
          orchestrationPlanId?: unknown;
          mode?: unknown;
        };
        if (Array.isArray(parsed.artifactIds) && parsed.artifactIds.every(id => typeof id === "string")) {
          artifactIds = parsed.artifactIds;
        }
        if (typeof parsed.orchestrationPlanId === "string") planId = parsed.orchestrationPlanId;
        if (typeof parsed.mode === "string") mode = parsed.mode;
      } catch {
        artifactIds = [];
      }
    }
    const artifacts = await this.deps.state.listArtifactsByTaskRun(
      approval.taskRunId,
    );
    const planArtifacts = artifacts.filter(
      (a) => a.kind === "orchestration_plan" && artifactIds.includes(a.id),
    );
    const planArtifact = planArtifacts.length === 1 ? planArtifacts[0] : undefined;
    if (!planArtifact || !planId) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Could not locate orchestration_plan artifact for approval ${approval.id}`,
      );
    }
    const parsed = parseStoredPlanArtifact(planArtifact, approval.taskRunId);
    if (!parsed || parsed.id !== planId || (mode !== undefined && parsed.mode !== mode)) {
      throw new OrchestrationError(
        "ORCHESTRATION_PLAN_NOT_FOUND",
        `Plan artifact ${planArtifact.id} does not match its approved checkpoint`,
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

// Marker text inside a JSON string is data, not framing. The planner appends a
// standalone marker after the display markdown, including any user examples.
const planMarkerRe = /^[\t ]*<!-- orchestration-plan:json -->[\t ]*\r?$/gm;
const planJsonRe = /^\s*```json[\t ]*\r?\n([\s\S]*?)\r?\n```[\t ]*\s*$/;

const lastPlanMarkerEnd = (summary: string): number | null => {
  planMarkerRe.lastIndex = 0;
  let end: number | null = null;
  for (let match = planMarkerRe.exec(summary); match !== null; match = planMarkerRe.exec(summary)) {
    end = match.index + match[0].length;
  }
  return end;
};

const parseStoredPlanArtifact = (artifact: Artifact, taskRunId: string) => {
  const summary = artifact.summary ?? "";
  if (artifact.taskRunId !== taskRunId || lastPlanMarkerEnd(summary) === null) return null;
  const plan = parseEmbeddedPlanJson(summary);
  return plan && artifact.uri === `harness:orchestration/${taskRunId}/${plan.id}` ? plan : null;
};
export const parseEmbeddedPlanJson = (
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
  const markerEnd = lastPlanMarkerEnd(summary);
  // The progression host already supplies the fragment after the marker.
  const match = planJsonRe.exec(markerEnd === null ? summary : summary.slice(markerEnd));
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
    if (!parsed || typeof parsed.id !== "string" || parsed.id.trim().length === 0 ||
        !(ORCHESTRATION_MODES as readonly unknown[]).includes(parsed.mode) || !Array.isArray(parsed.workerSteps))
      return null;
    for (const step of parsed.workerSteps) {
      if (!isStoredWorkerStep(step)) return null;
      validateWorkerStep(step);
    }
    orderWorkerStepsByDependencies(parsed.workerSteps);
    if (parsed.backflowRules !== undefined) {
      if (!Array.isArray(parsed.backflowRules) || !parsed.backflowRules.every(isWorkerBackflowRule)) return null;
      const stepIds = new Set(parsed.workerSteps.map(step => step.id));
      const ruleIds = new Set<string>();
      for (const rule of parsed.backflowRules) {
        if (ruleIds.has(rule.id) || !stepIds.has(rule.targetStepId) || !stepIds.has(rule.retryStepId)) return null;
        ruleIds.add(rule.id);
      }
    }
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

const isStoredWorkerStep = (value: unknown): value is OrchestrationPlan["workerSteps"][number] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return typeof step.id === "string" && step.id.trim().length > 0 &&
    typeof step.title === "string" && typeof step.inputSummary === "string" &&
    (WORKER_ROLES as readonly unknown[]).includes(step.role) &&
    typeof step.status === "string" && ["pending", "running", "succeeded", "failed", "skipped"].includes(step.status) &&
    Array.isArray(step.expectedArtifactKinds) && step.expectedArtifactKinds.every(kind => typeof kind === "string") &&
    (step.instruction === undefined || typeof step.instruction === "string") &&
    (step.agentProfileId === undefined || (typeof step.agentProfileId === "string" && step.agentProfileId.length > 0)) &&
    (step.remoteEndpointId === undefined || (typeof step.remoteEndpointId === "string" && step.remoteEndpointId.length > 0));
};
