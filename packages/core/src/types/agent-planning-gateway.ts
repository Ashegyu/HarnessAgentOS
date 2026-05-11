import type { Approval, CreateApprovalInput, ProposedActionDetails } from "./approval.ts";
import type { Artifact, CreateArtifactInput } from "./artifact.ts";
import type { Checkpoint, CreateCheckpointInput } from "./checkpoint.ts";
import type { QualityGateResult } from "./quality-gate-result.ts";
import type { Step, StepStatus, CreateStepInput } from "./step.ts";
import type { TaskRun, TaskRunStatus } from "./task-run.ts";
import type { Thread } from "./thread.ts";
import type {
  AgentInvocation,
  CreateAgentInvocationInput,
  UpdateAgentInvocationPatch,
} from "./agent-invocation.ts";

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
  /** Look up the thread that owns a TaskRun — used to chain agent sessions. */
  getThread(id: string): Promise<Thread | null>;
  /** Persist the Claude CLI session id on the thread (null clears it). */
  setThreadAgentSession(
    threadId: string,
    sessionId: string | null,
  ): Promise<Thread>;
}
