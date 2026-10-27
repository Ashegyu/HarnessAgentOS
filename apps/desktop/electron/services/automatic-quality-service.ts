import type {
  QualityGateInput,
  QualityGateResult,
  TaskRunCompletionService,
} from "@harness/core";
import { AsyncWorkScope } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import type { QualityEvaluator } from "@harness/quality";

export interface AutomaticQualityServiceDeps {
  state: Pick<LocalStateService, "getTaskRun">;
  evaluator: Pick<QualityEvaluator, "evaluate">;
  completion: Pick<
    TaskRunCompletionService,
    "applyQualityGateResult" | "markDone"
  >;
  onQualityGate?: (result: QualityGateResult) => Promise<void>;
  onQualityFailure?: (result: QualityGateResult) => Promise<void>;
  onTaskRunChanged?: (taskRunId: string) => void;
  onError?: (taskRunId: string, error: unknown) => void;
}

/**
 * Runs deterministic evidence evaluation after work reaches review state.
 * Passing gates complete automatically; warnings remain explicitly reviewable.
 */
export class AutomaticQualityService {
  private readonly deps: AutomaticQualityServiceDeps;
  private readonly pendingTaskRunIds = new Set<string>();
  private readonly operations = new AsyncWorkScope();

  constructor(deps: AutomaticQualityServiceDeps) {
    this.deps = deps;
  }

  schedule(taskRunId: string): void {
    if (this.operations.closed || !taskRunId || this.pendingTaskRunIds.has(taskRunId)) return;
    this.pendingTaskRunIds.add(taskRunId);
    void this.operations.run(() => this.evaluateIfReadyOnce(taskRunId))
      .catch((error: unknown) => this.deps.onError?.(taskRunId, error))
      .finally(() => this.pendingTaskRunIds.delete(taskRunId));
  }

  async evaluateIfReady(taskRunId: string): Promise<QualityGateResult | null> {
    if (this.operations.closed) return null;
    return this.operations.run(() => this.evaluateIfReadyOnce(taskRunId));
  }

  async shutdown(): Promise<void> {
    this.operations.seal();
    await this.operations.drain();
  }

  private async evaluateIfReadyOnce(taskRunId: string): Promise<QualityGateResult | null> {
    const taskRun = await this.deps.state.getTaskRun(taskRunId);
    if (this.operations.closed || !taskRun || taskRun.status !== "ready_for_review") return null;

    const input: QualityGateInput = { taskRunId };
    const result = await this.deps.evaluator.evaluate(input);
    await this.deps.completion.applyQualityGateResult(result);
    await this.observeQualityGate(result);

    if (result.status === "failed") {
      await this.deps.onQualityFailure?.(result);
    } else if (result.status === "passed") {
      await this.deps.completion.markDone({ taskRunId });
    }

    this.deps.onTaskRunChanged?.(taskRunId);
    return result;
  }

  private async observeQualityGate(result: QualityGateResult): Promise<void> {
    if (!this.deps.onQualityGate) return;
    try {
      await this.deps.onQualityGate(result);
    } catch {
      // Learning is advisory and must not block the quality transition.
    }
  }
}
