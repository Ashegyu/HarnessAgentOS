import {
  validateTargetDir,
  type AgentInvocation,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type Capability,
  type Checkpoint,
  type ConversationStateGateway,
  type CreateAgentInvocationInput,
  type CreateApprovalInput,
  type CreateArtifactInput,
  type CreateCapabilityInput,
  type CreateCheckpointInput,
  type CreateStepInput,
  type CreateTaskRunInput,
  type CreateThreadInput,
  type HarnessSettings,
  type LearningTrace,
  type LearningTracePatch,
  type QualityGateResult,
  type Step,
  type StepStatus,
  type TaskRun,
  type TaskRunStatus,
  type Thread,
  type ThreadDetail,
  type ProposedActionDetails,
  type UpdateAgentInvocationPatch,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import {
  SqliteAgentInvocationRepository,
  SqliteApprovalRepository,
  SqliteArtifactRepository,
  SqliteCapabilityRepository,
  SqliteCheckpointRepository,
  SqliteLearningTraceRepository,
  SqliteQualityGateRepository,
  SqliteSettingsRepository,
  SqliteStepRepository,
  SqliteTaskRunRepository,
  SqliteThreadRepository,
  SqliteAgentProfileRepository,
  SqliteMcpServerRepository,
  SqliteSkillSourceRepository,
  SqliteAgentPipelineRepository,
  type AgentInvocationRepository,
  type AgentPipelineRepository,
  type AgentProfileRepository,
  type ApprovalRepository,
  type ArtifactRepository,
  type CapabilityRepository,
  type CheckpointRepository,
  type LearningTraceRepository,
  type McpServerRepository,
  type QualityGateRepository,
  type SettingsRepository,
  type SkillSourceRepository,
  type StepRepository,
  type TaskRunRepository,
  type ThreadRepository,
} from "../repositories/index.ts";

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
  readonly settings: SettingsRepository;
  readonly agentProfiles: AgentProfileRepository;
  readonly mcpServers: McpServerRepository;
  readonly skillSources: SkillSourceRepository;
  readonly agentPipelines: AgentPipelineRepository;

  private readonly db: HarnessDb;
  constructor(db: HarnessDb) {
    this.db = db;
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
    this.settings = new SqliteSettingsRepository(db);
    this.agentProfiles = new SqliteAgentProfileRepository(db);
    this.mcpServers = new SqliteMcpServerRepository(db);
    this.skillSources = new SqliteSkillSourceRepository(db);
    this.agentPipelines = new SqliteAgentPipelineRepository(
      db,
      this.agentProfiles,
    );
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
    if (typeof input.pipelineId === "string" && input.pipelineId.length > 0) {
      payload.pipelineId = input.pipelineId;
    }
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

    // Attach the most recent `plan` artifact summary for each TaskRun so
    // the conversation workbench can render an agent reply bubble in
    // a single fetch. Plan artifacts live in `summary` (URI scheme is
    // a placeholder, see runner-ipc.readArtifact for the read path).
    const agentAnswers: Record<string, string> = {};
    if (taskRuns.length > 0) {
      const placeholders = taskRuns.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT a.task_run_id AS taskRunId, a.summary AS summary
           FROM artifacts a
           INNER JOIN (
             SELECT task_run_id, MAX(datetime(created_at)) AS max_at
             FROM artifacts
             WHERE kind = 'plan' AND task_run_id IN (${placeholders})
             GROUP BY task_run_id
           ) latest
             ON latest.task_run_id = a.task_run_id
            AND datetime(a.created_at) = latest.max_at
           WHERE a.kind = 'plan'`,
        )
        .all(...taskRuns.map((t) => t.id)) as Array<{
        taskRunId: string;
        summary: string | null;
      }>;
      for (const r of rows) {
        if (r.summary !== null) agentAnswers[r.taskRunId] = r.summary;
      }
    }
    return { thread, taskRuns, agentAnswers };
  }

  /**
   * Persist (or clear) the Claude CLI session id for a thread. Used by
   * the agent planner to chain `--resume` invocations within a single
   * conversation thread.
   */
  async setThreadAgentSession(
    threadId: string,
    sessionId: string | null,
  ): Promise<Thread> {
    return this.threads.update(threadId, { agentSessionId: sessionId });
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

  async deleteThread(id: string): Promise<void> {
    return this.threads.delete(id);
  }

  async deleteTaskRun(id: string): Promise<void> {
    return this.taskRuns.delete(id);
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
    details: ProposedActionDetails,
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

  // -- Settings (Phase 9) -----------------------------------------------

  async getSettings(): Promise<HarnessSettings> {
    return this.settings.get();
  }

  async updateSettings(settings: HarnessSettings): Promise<HarnessSettings> {
    return this.settings.update(settings);
  }

  // -- AgentPlanningStateGateway addition (Phase 4) ----------------------

  async listAgentProfiles() {
    return this.agentProfiles.list();
  }
}
