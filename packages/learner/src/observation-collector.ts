import type {
  Approval,
  Observation,
  QualityGateResult,
  TaskRun,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { deriveProjectKey } from "./project-key.ts";

export interface ObservationCollectorDeps {
  state: LocalStateService;
  projectKeyForTask?: (taskRun: TaskRun) => Promise<string>;
}

export class ObservationCollector {
  private readonly deps: ObservationCollectorDeps;

  constructor(deps: ObservationCollectorDeps) {
    this.deps = deps;
  }

  async recordApprovalDecision(approval: Approval): Promise<Observation | null> {
    if (
      approval.status !== "approved" &&
      approval.status !== "always_approved_for_run" &&
      approval.status !== "rejected"
    ) {
      return null;
    }
    const taskRun = await this.deps.state.getTaskRun(approval.taskRunId);
    if (!taskRun) return null;
    const projectKey = await this.projectKey(taskRun);
    return this.deps.state.createObservation({
      taskRunId: taskRun.id,
      threadId: taskRun.threadId,
      projectKey,
      source: "approval",
      eventType: approval.status,
      signal: approval.actionType,
      summary: `${approval.actionType} ${approval.status}`,
      payload: {
        approvalId: approval.id,
        actionType: approval.actionType,
        actionSummary: approval.actionSummary,
        status: approval.status,
        decisionMessage: approval.decisionMessage ?? null,
        policyDecision: approval.policyEvaluation?.decision ?? null,
      },
    });
  }

  async recordQualityGate(
    result: QualityGateResult,
  ): Promise<Observation | null> {
    if (result.status === "not_run") return null;
    const taskRun = await this.deps.state.getTaskRun(result.taskRunId);
    if (!taskRun) return null;
    const projectKey = await this.projectKey(taskRun);
    return this.deps.state.createObservation({
      taskRunId: taskRun.id,
      threadId: taskRun.threadId,
      projectKey,
      source: "quality",
      eventType: result.status,
      signal: result.status,
      summary: `quality gate ${result.status}`,
      payload: {
        qualityGateId: result.id,
        status: result.status,
        buildPassed: result.buildPassed ?? null,
        testsPassed: result.testsPassed ?? null,
        smokePassed: result.smokePassed ?? null,
        knownRisksCount: result.knownRisks.length,
        evidenceArtifactCount: result.evidenceArtifactIds.length,
      },
    });
  }

  private async projectKey(taskRun: TaskRun): Promise<string> {
    if (this.deps.projectKeyForTask) {
      return this.deps.projectKeyForTask(taskRun);
    }
    return deriveProjectKey({ targetDir: taskRun.targetDir });
  }
}
