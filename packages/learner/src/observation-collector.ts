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
    const observation = await this.deps.state.createObservation({
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
    await this.recordPinnedContextOutcome({
      taskRun,
      projectKey,
      qualityGate: result,
    });
    return observation;
  }

  private async projectKey(taskRun: TaskRun): Promise<string> {
    if (this.deps.projectKeyForTask) {
      return this.deps.projectKeyForTask(taskRun);
    }
    return deriveProjectKey({ targetDir: taskRun.targetDir });
  }

  private async recordPinnedContextOutcome(input: {
    taskRun: TaskRun;
    projectKey: string;
    qualityGate: QualityGateResult;
  }): Promise<void> {
    const contextPack = await this.latestPinnedContextPackObservation(
      input.taskRun.id,
    );
    if (!contextPack) return;
    const pinnedObservationIds = pinnedObservationIdsFromPayload(
      contextPack.payload,
    );
    if (pinnedObservationIds.length === 0) return;
    const contextPackArtifactId =
      typeof contextPack.payload.contextPackArtifactId === "string"
        ? contextPack.payload.contextPackArtifactId
        : null;
    await this.deps.state.createObservation({
      taskRunId: input.taskRun.id,
      threadId: input.taskRun.threadId,
      projectKey: input.projectKey,
      source: "learner",
      eventType: "pinned_context_outcome",
      signal: input.qualityGate.status,
      summary: `quality gate ${input.qualityGate.status} after ${pinnedObservationIds.length} pinned observations`,
      payload: {
        qualityGateId: input.qualityGate.id,
        qualityStatus: input.qualityGate.status,
        contextPackObservationId: contextPack.id,
        contextPackArtifactId,
        pinnedObservationIds,
        knownRisksCount: input.qualityGate.knownRisks.length,
        evidenceArtifactCount: input.qualityGate.evidenceArtifactIds.length,
      },
    });
  }

  private async latestPinnedContextPackObservation(
    taskRunId: string,
  ): Promise<Observation | null> {
    const observations = await this.deps.state.listObservations({
      taskRunId,
      limit: 50,
    });
    return (
      observations.find(
        (observation) =>
          observation.source === "agent" &&
          observation.eventType === "context_pack_created" &&
          observation.signal === "context_pack" &&
          pinnedObservationIdsFromPayload(observation.payload).length > 0,
      ) ?? null
    );
  }
}

const pinnedObservationIdsFromPayload = (
  payload: Record<string, unknown>,
): string[] => {
  const promptInclusion = payload.promptInclusion;
  if (!isRecord(promptInclusion)) return [];
  const pinnedObservationIds = promptInclusion.pinnedObservationIds;
  if (!Array.isArray(pinnedObservationIds)) return [];
  return pinnedObservationIds
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, 5);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
