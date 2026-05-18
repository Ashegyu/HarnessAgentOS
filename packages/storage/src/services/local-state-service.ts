import {
  evaluateApprovalActionPolicy,
  validateAbsoluteTargetDir,
  type AgentInvocation,
  type Approval,
  type ApprovalDecisionOptions,
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
  type CreateEvolutionCandidateInput,
  type CreateInstinctInput,
  type CreateObservationInput,
  type CreateStepInput,
  type CreateTaskRunInput,
  type CreateThreadInput,
  type EvolutionCandidate,
  type EvolutionCandidateStatus,
  type HarnessSettings,
  type Instinct,
  type InstinctStatus,
  type LearningTrace,
  type LearningTracePatch,
  type Observation,
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
  SqliteEvolutionCandidateRepository,
  SqliteInstinctRepository,
  SqliteLearningTraceRepository,
  SqliteObservationRepository,
  SqliteQualityGateRepository,
  SqliteSettingsRepository,
  SqliteStepRepository,
  SqliteTaskRunRepository,
  SqliteThreadRepository,
  SqliteAgentProfileRepository,
  SqliteMcpServerRepository,
  SqliteSkillSourceRepository,
  SqliteAgentPipelineRepository,
  SqliteA2ARemoteAgentRepository,
  SqliteRepoIndexRepository,
  SqliteRepairAttemptRepository,
  SqliteEvalRunRepository,
  type AgentInvocationRepository,
  type AgentPipelineRepository,
  type AgentProfileRepository,
  type A2ARemoteAgentRepository,
  type ApprovalRepository,
  type ArtifactRepository,
  type CapabilityRepository,
  type CheckpointRepository,
  type EvolutionCandidateRepository,
  type InstinctRepository,
  type LearningTraceRepository,
  type McpServerRepository,
  type ObservationRepository,
  type QualityGateRepository,
  type RepoIndexRepository,
  type RepairAttemptRepository,
  type EvalRunRepository,
  type SettingsRepository,
  type SkillSourceRepository,
  type StepRepository,
  type TaskRunRepository,
  type ThreadRepository,
} from "../repositories/index.ts";

const AGENT_PLAN_PLACEHOLDER_TITLE = "Awaiting agent plan";
const AGENT_PLAN_PLACEHOLDER_SUMMARY_PREFIX = "Agent mode TaskRun";

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
  readonly observations: ObservationRepository;
  readonly instincts: InstinctRepository;
  readonly evolutionCandidates: EvolutionCandidateRepository;
  readonly agentInvocations: AgentInvocationRepository;
  readonly settings: SettingsRepository;
  readonly agentProfiles: AgentProfileRepository;
  readonly mcpServers: McpServerRepository;
  readonly skillSources: SkillSourceRepository;
  readonly agentPipelines: AgentPipelineRepository;
  readonly a2aRemoteAgents: A2ARemoteAgentRepository;
  readonly repoIndex: RepoIndexRepository;
  readonly repairAttempts: RepairAttemptRepository;
  readonly evalRuns: EvalRunRepository;

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
    this.observations = new SqliteObservationRepository(db);
    this.instincts = new SqliteInstinctRepository(db);
    this.evolutionCandidates = new SqliteEvolutionCandidateRepository(db);
    this.agentInvocations = new SqliteAgentInvocationRepository(db);
    this.settings = new SqliteSettingsRepository(db);
    this.agentProfiles = new SqliteAgentProfileRepository(db);
    this.mcpServers = new SqliteMcpServerRepository(db);
    this.skillSources = new SqliteSkillSourceRepository(db);
    this.a2aRemoteAgents = new SqliteA2ARemoteAgentRepository(db);
    this.repoIndex = new SqliteRepoIndexRepository(db);
    this.repairAttempts = new SqliteRepairAttemptRepository(db);
    this.evalRuns = new SqliteEvalRunRepository(db);
    this.agentPipelines = new SqliteAgentPipelineRepository(
      db,
      this.agentProfiles,
      this.a2aRemoteAgents,
    );
  }

  // -- Thread / TaskRun --------------------------------------------------

  async createThread(input: CreateThreadInput): Promise<Thread> {
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new Error("Thread title must be a non-empty string");
    }
    let normalizedTargetDir: string | undefined;
    if (input.targetDir !== undefined) {
      const v = validateAbsoluteTargetDir(input.targetDir);
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

    // Attach the most recent persisted agent answer for each TaskRun so
    // the conversation workbench can render an agent reply bubble in a
    // single fetch. Prefer raw provider output logs because they can be
    // rehydrated into thinking/tool/intermediate/final stream sections;
    // fall back to the latest plan summary for older runs.
    const agentAnswers: Record<string, string> = {};
    if (taskRuns.length > 0) {
      const placeholders = taskRuns.map(() => "?").join(",");
      const rawRows = this.db
        .prepare(
          `SELECT
             a.task_run_id AS taskRunId,
             a.title AS title,
             a.summary AS summary
           FROM artifacts a
           WHERE a.kind = 'log'
             AND a.task_run_id IN (${placeholders})
             AND (
               a.title = 'Agent raw output'
               OR a.title LIKE 'Worker raw output%'
             )
             AND a.rowid = (
               SELECT a2.rowid
               FROM artifacts a2
               WHERE a2.kind = 'log'
                 AND a2.task_run_id = a.task_run_id
                 AND (
                   a2.title = 'Agent raw output'
                   OR a2.title LIKE 'Worker raw output%'
                 )
               ORDER BY datetime(a2.created_at) DESC, a2.rowid DESC
               LIMIT 1
             )`,
        )
        .all(...taskRuns.map((t) => t.id)) as Array<{
        taskRunId: string;
        title: string | null;
        summary: string | null;
      }>;
      for (const r of rawRows) {
        if (r.summary !== null && r.summary.length > 0) {
          agentAnswers[r.taskRunId] = r.summary;
        }
      }

      const rows = this.db
        .prepare(
          `SELECT
             a.task_run_id AS taskRunId,
             a.title AS title,
             a.summary AS summary
           FROM artifacts a
           WHERE a.kind = 'plan'
             AND a.task_run_id IN (${placeholders})
             AND a.rowid = (
               SELECT a2.rowid
               FROM artifacts a2
               WHERE a2.kind = 'plan'
                 AND a2.task_run_id = a.task_run_id
               ORDER BY datetime(a2.created_at) DESC, a2.rowid DESC
               LIMIT 1
             )`,
        )
        .all(...taskRuns.map((t) => t.id)) as Array<{
        taskRunId: string;
        title: string | null;
        summary: string | null;
      }>;
      for (const r of rows) {
        if (
          agentAnswers[r.taskRunId] === undefined &&
          r.summary !== null &&
          !isAgentPlanPlaceholder(r.title, r.summary)
        ) {
          agentAnswers[r.taskRunId] = r.summary;
        }
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
    const v = validateAbsoluteTargetDir(input.targetDir);
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
    return this.approvals.create({
      ...input,
      policyEvaluation:
        input.policyEvaluation ?? evaluateApprovalActionPolicy(input.actionType),
    });
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.approvals.get(id);
  }

  async decideApproval(
    id: string,
    decision: ApprovalStatus,
    message?: string,
    options?: ApprovalDecisionOptions,
  ): Promise<Approval> {
    return this.approvals.decide(id, decision, message, options);
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

  async sumLearningTraceCostByTaskRun(taskRunId: string): Promise<number> {
    return this.learningTraces.sumCostByTaskRun(taskRunId);
  }

  async sumLearningTraceCostByDay(input: {
    profileId?: string;
    isoDate: string;
  }): Promise<number> {
    return this.learningTraces.sumCostByDay(input);
  }

  // -- Observation / Instinct (Agent Framework adoption Phase 2) ---------

  async createObservation(
    input: CreateObservationInput,
  ): Promise<Observation> {
    return this.observations.create(input);
  }

  async listObservations(input?: {
    projectKey?: string;
    taskRunId?: string;
    limit?: number;
  }): Promise<Observation[]> {
    return this.observations.list(input);
  }

  async createEvolutionCandidate(
    input: CreateEvolutionCandidateInput,
  ): Promise<EvolutionCandidate> {
    return this.evolutionCandidates.create(input);
  }

  async listEvolutionCandidates(input?: {
    projectKey?: string;
    status?: EvolutionCandidateStatus;
  }): Promise<EvolutionCandidate[]> {
    return this.evolutionCandidates.list(input);
  }

  async getEvolutionCandidate(id: string): Promise<EvolutionCandidate | null> {
    return this.evolutionCandidates.get(id);
  }

  async updateEvolutionCandidateStatus(
    id: string,
    status: EvolutionCandidateStatus,
  ): Promise<EvolutionCandidate> {
    return this.evolutionCandidates.updateStatus(id, status);
  }

  async createInstinct(input: CreateInstinctInput): Promise<Instinct> {
    return this.instincts.create(input);
  }

  async listInstincts(input?: {
    projectKey?: string;
    includeDisabled?: boolean;
  }): Promise<Instinct[]> {
    return this.instincts.list(input);
  }

  async getInstinct(id: string): Promise<Instinct | null> {
    return this.instincts.get(id);
  }

  async updateInstinctStatus(
    id: string,
    status: InstinctStatus,
  ): Promise<Instinct> {
    return this.instincts.updateStatus(id, status);
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

const isAgentPlanPlaceholder = (
  title: string | null,
  summary: string,
): boolean =>
  title === AGENT_PLAN_PLACEHOLDER_TITLE ||
  summary.startsWith(AGENT_PLAN_PLACEHOLDER_SUMMARY_PREFIX);
