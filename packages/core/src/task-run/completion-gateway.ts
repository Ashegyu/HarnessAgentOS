import type {
  Approval,
  Artifact,
  Checkpoint,
  CreateApprovalInput,
  CreateArtifactInput,
  CreateCheckpointInput,
  CreateStepInput,
  QualityGateResult,
  Step,
  StepStatus,
  TaskRun,
  TaskRunStatus,
} from "../types/index.ts";

/**
 * Storage gateway used by the task-run completion service. Mirrors the
 * subset of LocalStateService that this service needs so the @harness/core
 * package stays free of @harness/storage imports and tests can swap in
 * lightweight fakes.
 */
export interface TaskRunCompletionGateway {
  // TaskRun
  getTaskRun(id: string): Promise<TaskRun | null>;
  setTaskRunStatus(id: string, status: TaskRunStatus): Promise<TaskRun>;
  setTaskRunCurrentStep(id: string, stepId: string | null): Promise<TaskRun>;

  // Step / Checkpoint / Approval / Artifact
  createStep(input: CreateStepInput): Promise<Step>;
  setStepStatus(
    id: string,
    status: StepStatus,
    patch?: { outputSummary?: string },
  ): Promise<Step>;
  listStepsByTaskRun(taskRunId: string): Promise<Step[]>;
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  createApproval(input: CreateApprovalInput): Promise<Approval>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;

  // Quality
  createQualityGateResult(
    result: QualityGateResult,
  ): Promise<QualityGateResult>;
  getLatestQualityGateResult(
    taskRunId: string,
  ): Promise<QualityGateResult | null>;
  listArtifactsByTaskRun(taskRunId: string): Promise<Artifact[]>;
}
