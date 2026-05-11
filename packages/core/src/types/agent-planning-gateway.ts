import type { Approval, CreateApprovalInput, ProposedActionDetails } from "./approval";
import type { Artifact, CreateArtifactInput } from "./artifact";
import type { Checkpoint, CreateCheckpointInput } from "./checkpoint";
import type { QualityGateResult } from "./quality-gate-result";
import type { Step, StepStatus, CreateStepInput } from "./step";
import type { TaskRun, TaskRunStatus } from "./task-run";
import type {
  AgentInvocation,
  CreateAgentInvocationInput,
  UpdateAgentInvocationPatch,
} from "./agent-invocation";

/**
 * Narrow persistence interface required by AgentPlanningService.
 * Defined in @harness/core so the agent package does not depend on
 * @harness/storage. LocalStateService satisfies this interface
 * structurally.
 */
export interface AgentPlanningStateGateway {
  getTaskRun(id: string): Promise<TaskRun | null>;
  listStepsByTaskRun(taskRunId: string): Promise<Step[]>;
  createStep(input: CreateStepInput): Promise<Step>;
  listArtifactsByTaskRun(taskRunId: string): Promise<Artifact[]>;
  getLatestQualityGateResult(taskRunId: string): Promise<QualityGateResult | null>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;
  createAgentInvocation(input: CreateAgentInvocationInput): Promise<AgentInvocation>;
  updateAgentInvocation(id: string, patch: UpdateAgentInvocationPatch): Promise<AgentInvocation>;
  setStepStatus(id: string, status: StepStatus, patch?: { outputSummary?: string }): Promise<Step>;
  setTaskRunStatus(id: string, status: TaskRunStatus): Promise<TaskRun>;
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  createApproval(input: CreateApprovalInput): Promise<Approval>;
  setApprovalProposedAction(id: string, details: ProposedActionDetails): Promise<Approval>;
  setTaskRunCurrentStep(id: string, stepId: string | null): Promise<TaskRun>;
  getAgentInvocation(id: string): Promise<AgentInvocation | null>;
}
