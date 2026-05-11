import {
  validateTargetDir,
  type AgentInvocation,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type Capability,
  type Checkpoint,
  type ConversationStateGateway,
  type CreateApprovalInput,
  type CreateArtifactInput,
  type CreateCapabilityInput,
  type CreateCheckpointInput,
  type CreateStepInput,
  type CreateTaskRunInput,
  type CreateThreadInput,
  type LearningTrace,
  type LearningTracePatch,
  type QualityGateResult,
  type Step,
  type StepStatus,
  type TaskRun,
  type TaskRunStatus,
  type Thread,
  type ThreadDetail,
} from "@harness/core";
import type { HarnessDb } from "../db";
import {
  SqliteAgentInvocationRepository,
  SqliteApprovalRepository,
  SqliteArtifactRepository,
  SqliteCapabilityRepository,
  SqliteCheckpointRepository,
  SqliteLearningTraceRepository,
  SqliteQualityGateRepository,
  SqliteStepRepository,
  SqliteTaskRunRepository,
  SqliteThreadRepository,
  type AgentInvocationRepository,
  type ApprovalRepository,
  type ArtifactRepository,
  type CapabilityRepository,
  type CheckpointRepository,
  type CreateAgentInvocationInput,
  type LearningTraceRepository,
  type QualityGateRepository,
  type StepRepository,
  type TaskRunRepository,
  type ThreadRepository,
  type UpdateAgentInvocationPatch,
} from "../repositories";

/**
 * LocalStateService is the single business-logic gateway over the
 * SQLite repositories. IPC handlers and downstream services depend on
 * this; they never touch repositories or the DB handle directly.
 *
 * Implements ConversationStateGateway so the @harness/core conversation
 * package can drive multi-row creation without an @harness/storage
 * dependency.
 *
 * Source: docs/implementation/phase-01-local-state-model.md (구현 단위)
 */
export class LocalStateService implements ConversationStateGateway {
  readonly threads: ThreadRepository;
  readonly taskRuns: TaskRunRepository;
  readonly steps: StepRepository;
  readonly checkpoints: CheckpointRepository;
  readonly approvals: ApprovalRepository;
  readonly artifacts: ArtifactRepository;
  readonly qualityGates: QualityGateRepository;
  readonly capabilities: CapabilityRepository;
  readonly learningTraces: LearningTraceRepository;
  readonly agentInvocations: AgentInvocationRepository;

  constructor(private readonly db: HarnessDb) {
    this.threads = new SqliteThreadRepository(db);
    this.taskRuns = new SqliteTaskRunRepository(db);
    this.steps = new SqliteStepRepository(db);
    this.checkpoints = new SqliteCheckpointRepository(db);
    this.approvals = new SqliteApprovalRepository(db);
    this.artifacts = new SqliteArtifactRepository(db);
    this.qualityGates = new SqliteQualityGateRepository(db);
    this.capabilities = new SqliteCapabilityRepository(db);
    this.learningTraces = new SqliteLearningTraceRepository(db);
    this.agentInvocations = new SqliteAgentInvocationRepository(db);
  }

  // -- Thread / TaskRun --------------------------------------------------

  async createThread(input: CreateThreadInput): Promise<Thread> {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new Error("Thread title must be a non-empty string");
    }
    let normalizedTargetDir: string | undefined;
    if (input.targetDir !== undefined) {
      const v = validateTargetDir(input.targetDir);
      if (!v.ok) throw new Error(`Invalid targetDir: ${v.reason}`);
      normalizedTargetDir = v.normalized;
    }
    const payload: CreateThreadInput = { title: input.title.trim() };
    if (normalizedTargetDir !== undefined) payload.targetDir = normalizedTargetDir;
    return this.threads.create(payload);
  }

  async listThreads(): Promise<Thread[]> {
    return this.threads.list();
  }

  async getThread(id: string): Promise<Thread | null> {
    return this.threads.get(id);
  }

  async getThreadDetail(threadId: string): Promise<ThreadDetail | null> {
    const thread = await this.threads.get(threadId);
    if (!thread) return null;
    const taskRuns = await this.taskRuns.listByThread(threadId);
    return { thread, taskRuns };
  }

  async createTaskRun(input: CreateTaskRunInput): Promise<TaskRun> {
    const v = validateTargetDir(input.targetDir);
    if (!v.ok) throw new Error(`Invalid targetDir: ${v.reason}`);
    if (typeof input.userRequest !== "string" || input.userRequest.trim().length === 0) {
      throw new Error("userRequest must be a non-empty string");
    }
    const thread = await this.threads.get(input.threadId);
    if (!thread) throw new Error(`Thread ${input.threadId} not found`);
    return this.taskRuns.create({
      threadId: input.threadId,
      userRequest: input.userRequest,
      targetDir: v.normalized,
      ...(input.status ? { status: input.status } : {}),
    });
  }

  async getTaskRun(id: string): Promise<TaskRun | null> {
    return this.taskRuns.get(id);
  }

  async setTaskRunStatus(id: string, status: TaskRunStatus): Promise<TaskRun> {
    return this.taskRuns.updateStatus(id, status);
  }

  async setTaskRunCurrentStep(
    id: string,
    stepId: string | null,
  ): Promise<TaskRun> {
    return this.taskRuns.setCurrentStep(id, stepId);
  }

  // -- Step ---------------------------------------------------------------

  async createStep(input: CreateStepInput): Promise<Step> {
    return this.steps.create(input);
  }

  async setStepStatus(
    id: string,
    status: StepStatus,
    patch?: { outputSummary?: string },
  ): Promise<Step> {
    return this.steps.updateStatus(id, status, patch);
  }

  async listStepsByTaskRun(taskRunId: string): Promise<Step[]> {
    return this.steps.listByTaskRun(taskRunId);
  }

  // -- Checkpoint / Approval / Artifact -----------------------------------

  async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    return this.checkpoints.create(input);
  }

  async createApproval(input: CreateApprovalInput): Promise<Approval> {
    return this.approvals.create(input);
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.approvals.get(id);
  }

  async decideApproval(
    id: string,
    decision: ApprovalStatus,
    message?: string,
  ): Promise<Approval> {
    return this.approvals.decide(id, decision, message);
  }

  async setApprovalProposedAction(
    id: string,
    details: import("@harness/core").ProposedActionDetails,
  ): Promise<Approval> {
    return this.approvals.setProposedAction(id, details);
  }

  async listPendingApprovalsForTaskRun(taskRunId: string): Promise<Approval[]> {
    const all = await this.approvals.listByTaskRun(taskRunId);
    return all.filter((a) => a.status === "pending");
  }

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    return this.artifacts.create(input);
  }

  async listArtifactsByTaskRun(taskRunId: string): Promise<Artifact[]> {
    return this.artifacts.listByTaskRun(taskRunId);
  }

  async listCheckpointsByTaskRun(taskRunId: string): Promise<Checkpoint[]> {
    return this.checkpoints.listByTaskRun(taskRunId);
  }

  async listApprovalsByTaskRun(taskRunId: string): Promise<Approval[]> {
    return this.approvals.listByTaskRun(taskRunId);
  }

  // -- Quality Gate -------------------------------------------------------

  async createQualityGateResult(
    result: QualityGateResult,
  ): Promise<QualityGateResult> {
    return this.qualityGates.create(result);
  }

  async listQualityGateResults(
    taskRunId: string,
  ): Promise<QualityGateResult[]> {
    return this.qualityGates.listByTaskRun(taskRunId);
  }

  async getLatestQualityGateResult(
    taskRunId: string,
  ): Promise<QualityGateResult | null> {
    return this.qualityGates.getLatestForTaskRun(taskRunId);
  }

  // -- Capability ----------------------------------------------------------

  async upsertCapability(
    input: CreateCapabilityInput,
  ): Promise<Capability> {
    return this.capabilities.upsert(input);
  }

  async listCapabilities(): Promise<Capability[]> {
    return this.capabilities.list();
  }

  async getCapability(id: string): Promise<Capability | null> {
    return this.capabilities.get(id);
  }

  async pruneCapabilities(
    source: string,
    keepIds: string[],
  ): Promise<void> {
    return this.capabilities.removeBySource(source, keepIds);
  }

  // -- LearningTrace -------------------------------------------------------

  async createLearningTrace(input: {
    taskRunId: string;
  }): Promise<LearningTrace> {
    return this.learningTraces.create(input);
  }

  async updateLearningTrace(
    id: string,
    patch: LearningTracePatch,
  ): Promise<LearningTrace> {
    return this.learningTraces.update(id, patch);
  }

  async getLearningTraceByTaskRun(
    taskRunId: string,
  ): Promise<LearningTrace | null> {
    return this.learningTraces.getByTaskRun(taskRunId);
  }

  async listLearningTraces(): Promise<LearningTrace[]> {
    return this.learningTraces.list();
  }

  // -- AgentInvocation (Phase 8) ----------------------------------------

  async createAgentInvocation(
    input: CreateAgentInvocationInput,
  ): Promise<AgentInvocation> {
    return this.agentInvocations.create(input);
  }

  async updateAgentInvocation(
    id: string,
    patch: UpdateAgentInvocationPatch,
  ): Promise<AgentInvocation> {
    return this.agentInvocations.update(id, patch);
  }

  async getAgentInvocation(id: string): Promise<AgentInvocation | null> {
    return this.agentInvocations.get(id);
  }

  async listAgentInvocationsByTaskRun(
    taskRunId: string,
  ): Promise<AgentInvocation[]> {
    return this.agentInvocations.listByTaskRun(taskRunId);
  }

  async getLatestAgentInvocation(
    taskRunId: string,
  ): Promise<AgentInvocation | null> {
    return this.agentInvocations.getLatestForTaskRun(taskRunId);
  }
}
