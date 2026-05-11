import type {
  LearningTrace,
  QualityGateResult,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { computeReward } from "./reward-evaluator.ts";
import { redactSecrets } from "./redact-secrets.ts";

/**
 * Phase 6 trace recorder. Wraps LocalStateService so the rest of the
 * app can stamp learning data without knowing about the underlying
 * repository. Never executes external side effects.
 */
export interface TraceRecorderDeps {
  state: LocalStateService;
}

export class TraceRecorder {
  private readonly deps: TraceRecorderDeps;
  constructor(deps: TraceRecorderDeps) {
    this.deps = deps;
  }

  async ensureTrace(taskRunId: string): Promise<LearningTrace> {
    const existing = await this.deps.state.getLearningTraceByTaskRun(taskRunId);
    if (existing) return existing;
    return this.deps.state.createLearningTrace({ taskRunId });
  }

  async recordSelection(input: {
    taskRunId: string;
    selectedModel?: string;
    selectedCapabilities?: string[];
  }): Promise<LearningTrace> {
    const trace = await this.ensureTrace(input.taskRunId);
    const patch: Parameters<typeof this.deps.state.updateLearningTrace>[1] = {};
    if (input.selectedModel !== undefined)
      patch.selectedModel = input.selectedModel;
    if (input.selectedCapabilities !== undefined)
      patch.selectedCapabilities = input.selectedCapabilities;
    return this.deps.state.updateLearningTrace(trace.id, patch);
  }

  async recordOutcome(input: {
    taskRunId: string;
    qualityGate?: QualityGateResult | null;
    latencyMs?: number;
    costEstimate?: number;
    success?: boolean;
    failureReason?: string;
  }): Promise<LearningTrace> {
    const trace = await this.ensureTrace(input.taskRunId);
    const reward = computeReward({
      qualityGate: input.qualityGate ?? null,
      latencyMs: input.latencyMs,
      success: input.success,
    });
    const patch: Parameters<typeof this.deps.state.updateLearningTrace>[1] = {
      reward,
    };
    if (input.latencyMs !== undefined) patch.latencyMs = input.latencyMs;
    if (input.costEstimate !== undefined)
      patch.costEstimate = input.costEstimate;
    if (input.success !== undefined) patch.success = input.success;
    if (input.failureReason !== undefined)
      patch.failureReason = redactSecrets(input.failureReason);
    return this.deps.state.updateLearningTrace(trace.id, patch);
  }
}

