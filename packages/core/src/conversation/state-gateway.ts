import type {
  Approval,
  ApprovalDecisionOptions,
  ApprovalStatus,
  Artifact,
  Checkpoint,
  CreateApprovalInput,
  CreateArtifactInput,
  CreateCheckpointInput,
  CreateStepInput,
  CreateTaskRunInput,
  CreateThreadInput,
  ProposedActionDetails,
  PrepareActionRetryInput,
  Step,
  StepStatus,
  TaskRun,
  TaskRunStatus,
  Thread,
} from "../types";

/** Only synchronous storage operations may run inside an atomic draft write. */
export interface ConversationTransactionGateway {
  getThread(id: string): Thread | null;
  createThread(input: CreateThreadInput): Thread;
  getTaskRun(id: string): TaskRun | null;
  createTaskRun(input: CreateTaskRunInput): TaskRun;
  setTaskRunStatus(id: string, status: TaskRunStatus): TaskRun;
  setTaskRunCurrentStep(id: string, stepId: string | null): TaskRun;
  createStep(input: CreateStepInput): Step;
  setStepStatus(id: string, status: StepStatus, patch?: { outputSummary?: string }): Step;
  createCheckpoint(input: CreateCheckpointInput): Checkpoint;
  createApproval(input: CreateApprovalInput): Approval;
  createArtifact(input: CreateArtifactInput): Artifact;
}

export type SynchronousTransactionResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);

/**
 * Subset of LocalStateService used by ConversationService. Allows the
 * core conversation package to stay free of @harness/storage imports
 * and lets tests inject lightweight in-memory fakes.
 */
export interface ConversationStateGateway {
  prepareApprovalRetry(input: PrepareActionRetryInput): Promise<Approval>;
  withTransaction<T>(
    work: (state: ConversationTransactionGateway) => SynchronousTransactionResult<T>,
  ): T;

  // Thread
  getThread(id: string): Promise<Thread | null>;
  createThread(input: CreateThreadInput): Promise<Thread>;

  // TaskRun
  createTaskRun(input: CreateTaskRunInput): Promise<TaskRun>;
  getTaskRun(id: string): Promise<TaskRun | null>;
  setTaskRunStatus(id: string, status: TaskRunStatus): Promise<TaskRun>;
  setTaskRunCurrentStep(id: string, stepId: string | null): Promise<TaskRun>;

  // Step
  createStep(input: CreateStepInput): Promise<Step>;
  setStepStatus(
    id: string,
    status: StepStatus,
    patch?: { outputSummary?: string },
  ): Promise<Step>;
  listStepsByTaskRun(taskRunId: string): Promise<Step[]>;

  // Checkpoint / Approval / Artifact
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  createApproval(input: CreateApprovalInput): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  decideApproval(
    id: string,
    decision: ApprovalStatus,
    message?: string,
    options?: ApprovalDecisionOptions,
  ): Promise<Approval>;
  setApprovalProposedAction(
    id: string,
    details: ProposedActionDetails,
  ): Promise<Approval>;
  listPendingApprovalsForTaskRun(taskRunId: string): Promise<Approval[]>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
}
