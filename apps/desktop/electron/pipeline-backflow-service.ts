import type { LocalStateService } from "@harness/storage";
import {
  WorkerRunner,
  OrchestrationError,
  type OrchestrationService,
  type WorkerCliInvoker,
} from "@harness/orchestration";
import type { QualityGateResult } from "@harness/core";

const RESUMABLE_STATUSES = new Set(["running", "waiting_for_approval", "ready_for_review"]);

export interface PipelineBackflowServiceDeps {
  state: LocalStateService;
  orchestration: OrchestrationService;
  agentPlanning?: WorkerCliInvoker;
  onTaskRunChanged?: (taskRunId: string) => void | Promise<void>;
}

export class PipelineBackflowService {
  private readonly deps: PipelineBackflowServiceDeps;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private stopping = false;

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inflight.values()]);
  }

  constructor(deps: PipelineBackflowServiceDeps) {
    this.deps = deps;
  }

  runForQualityFailure(
    result: QualityGateResult,
  ): Promise<boolean> {
    if (result.status !== "failed") return Promise.resolve(false);
    return this.runOnce(result.taskRunId, () => this.startQualityFailure(result));
  }

  resumePending(taskRunId: string): Promise<boolean> {
    return this.runOnce(taskRunId, async () => {
      const task = await this.deps.state.getTaskRun(taskRunId);
      if (!task || !RESUMABLE_STATUSES.has(task.status)) return false;
      const attempts = await this.deps.state.pipelineBackflows.listByTaskRun(taskRunId);
      if (!attempts.some(attempt => attempt.trigger === "quality_failed" &&
          (attempt.status === "running" || (attempt.status === "failed" && attempt.completedAt !== undefined)))) return false;
      const plan = await this.deps.orchestration.getLatestPlan({ taskRunId });
      if (!plan) return false;
      const planAttempts = attempts.filter(attempt => attempt.planId === plan.id && attempt.trigger === "quality_failed" &&
        plan.backflowRules?.some(rule => rule.id === attempt.ruleId && rule.trigger === "quality_failed"));
      const running = planAttempts.filter(attempt => attempt.status === "running");
      const failed = planAttempts.filter(attempt =>
        attempt.status === "failed" && attempt.completedAt !== undefined);
      if (running.length === 0 && (failed.length === 0 || task.status !== "running" || !task.currentStepId)) return false;
      if (running.length === 0) {
        const artifacts = await this.deps.state.listArtifactsByTaskRun(taskRunId);
        const currentArtifactUris = new Set(artifacts.filter(artifact =>
          artifact.kind === "log" && artifact.stepId === task.currentStepId).map(artifact => artifact.uri));
        const failedContinuation = failed.find(attempt =>
          plan.workerSteps.some(step => currentArtifactUris.has(
            `harness:orchestration/${plan.id}/${step.id}/backflow/${attempt.id}`)));
        if (failedContinuation) {
          throw new OrchestrationError("PIPELINE_BACKFLOW_FAILED",
            `Backflow ${failedContinuation.ruleId} failed before Resume; inspect the failed worker before requesting another quality retry.`);
        }
        return false;
      }
      const attempt = running[0]!;
      const result = await this.createRunner().runQualityBackflow({ plan, reason: attempt.reason ?? "Resuming quality backflow" });
      return result !== null;
    });
  }

  private runOnce(taskRunId: string, work: () => Promise<boolean>): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    const existing = this.inflight.get(taskRunId);
    if (existing) return existing;
    const pending = Promise.resolve().then(work).finally(() => this.inflight.delete(taskRunId));
    this.inflight.set(taskRunId, pending);
    return pending;
  }

  private async startQualityFailure(result: QualityGateResult): Promise<boolean> {
    const task = await this.deps.state.getTaskRun(result.taskRunId);
    if (!task || (!RESUMABLE_STATUSES.has(task.status) && task.status !== "quality_failed")) return false;
    const plan = await this.deps.orchestration.getLatestPlan({
      taskRunId: result.taskRunId,
    });
    if (!plan?.backflowRules?.some((rule) => rule.trigger === "quality_failed")) {
      return false;
    }
    const outcome = await this.createRunner().runQualityBackflow({
      plan,
      reason: `QualityGate ${result.id} failed`,
    });
    return outcome !== null;
  }

  private createRunner(): WorkerRunner {
    return new WorkerRunner({
      state: this.deps.state,
      ...(this.deps.agentPlanning ? { agentPlanning: this.deps.agentPlanning } : {}),
      ...(this.deps.onTaskRunChanged
        ? { onTaskRunChanged: this.deps.onTaskRunChanged }
        : {}),
    });
  }
}
