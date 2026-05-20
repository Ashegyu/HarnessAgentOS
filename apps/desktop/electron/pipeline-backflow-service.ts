import type { LocalStateService } from "@harness/storage";
import {
  WorkerRunner,
  type OrchestrationService,
  type WorkerCliInvoker,
} from "@harness/orchestration";
import type { QualityGateResult } from "@harness/core";

export interface PipelineBackflowServiceDeps {
  state: LocalStateService;
  orchestration: OrchestrationService;
  agentPlanning?: WorkerCliInvoker;
  onTaskRunChanged?: (taskRunId: string) => void | Promise<void>;
}

export class PipelineBackflowService {
  private readonly deps: PipelineBackflowServiceDeps;

  constructor(deps: PipelineBackflowServiceDeps) {
    this.deps = deps;
  }

  async runForQualityFailure(
    result: QualityGateResult,
  ): Promise<boolean> {
    if (result.status !== "failed") return false;
    const plan = await this.deps.orchestration.getLatestPlan({
      taskRunId: result.taskRunId,
    });
    if (!plan?.backflowRules?.some((rule) => rule.trigger === "quality_failed")) {
      return false;
    }
    const runner = new WorkerRunner({
      state: this.deps.state,
      ...(this.deps.agentPlanning ? { agentPlanning: this.deps.agentPlanning } : {}),
      ...(this.deps.onTaskRunChanged
        ? { onTaskRunChanged: this.deps.onTaskRunChanged }
        : {}),
    });
    await runner.runQualityBackflow({
      plan,
      reason: `QualityGate ${result.id} failed`,
    });
    return true;
  }
}
