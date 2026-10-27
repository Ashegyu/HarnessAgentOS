import {
  assertTaskRunTransition,
  evaluateApprovalActionPolicy,
  canReviewApprovalExecution,
  taskContractFor,
  taskContractBlocksAction,
  validateProposedActionDetails,
  redactSecrets,
  type PrepareActionRetryInput,
  validateAbsoluteTargetDir,
  type AgentInvocation,
  type Approval,
  type ApprovalDecisionOptions,
  type ApprovalStatus,
  type Artifact,
  type Capability,
  type Checkpoint,
  type ConversationStateGateway,
  type ConversationTransactionGateway,
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
  type DecisionLogInput,
  type DecisionLogPage,
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
  type SynchronousTransactionResult,
  type DatabaseDiagnosticsSnapshot,
  type TaskRun,
  type TaskRunStatus,
  type Thread,
  type ThreadDetail,
  type RecentTaskRun,
  type ProposedActionDetails,
  type UpdateAgentInvocationPatch,
} from "@harness/core";
import { statSync } from "node:fs";
import { types } from "node:util";
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
  SqliteHarnessPackageRepository,
  SqliteHarnessBindingSetRepository,
  SqliteAgentPipelineRepository,
  SqlitePipelineBackflowRepository,
  SqliteA2ARemoteAgentRepository,
  SqliteA2ARefinementAttemptRepository,
  SqliteRepoIndexRepository,
  SqliteRepairAttemptRepository,
  SqliteEvalRunRepository,
  SqliteValidationRunRepository,
  SqliteWorkspaceMutationRepository,
  type AgentInvocationRepository,
  type AgentPipelineRepository,
  type PipelineBackflowRepository,
  type AgentProfileRepository,
  type A2ARemoteAgentRepository,
  type A2ARefinementAttemptRepository,
  type CapabilityRepository,
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
  type HarnessPackageRepository,
  type HarnessBindingSetRepository,
} from "../repositories/index.ts";
import { serializeThreadMarkdown } from "./thread-markdown-export.ts";
import { rowToTaskRun } from "../repositories/row-mappers.ts";
import { captureValidationRevision, resolveValidationWorkspaceKey } from "./workspace-validation-revision.ts";

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
  readonly threads: SqliteThreadRepository;
  readonly taskRuns: SqliteTaskRunRepository;
  readonly steps: SqliteStepRepository;
  readonly checkpoints: SqliteCheckpointRepository;
  readonly approvals: SqliteApprovalRepository;
  readonly artifacts: SqliteArtifactRepository;
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
  readonly harnessPackages: HarnessPackageRepository;
  readonly harnessBindingSets: HarnessBindingSetRepository;
  readonly agentPipelines: AgentPipelineRepository;
  readonly pipelineBackflows: PipelineBackflowRepository;
  readonly a2aRemoteAgents: A2ARemoteAgentRepository;
  readonly a2aRefinements: A2ARefinementAttemptRepository;
  readonly repoIndex: RepoIndexRepository;
  readonly repairAttempts: RepairAttemptRepository;
  readonly evalRuns: EvalRunRepository;
  readonly validationRuns: SqliteValidationRunRepository;
  readonly workspaceMutations: SqliteWorkspaceMutationRepository;

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
    this.validationRuns = new SqliteValidationRunRepository(db);
    this.workspaceMutations = new SqliteWorkspaceMutationRepository(db);
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
    this.harnessPackages = new SqliteHarnessPackageRepository(db);
    this.harnessBindingSets = new SqliteHarnessBindingSetRepository(db);
    this.a2aRemoteAgents = new SqliteA2ARemoteAgentRepository(db);
    this.repoIndex = new SqliteRepoIndexRepository(db);
    this.repairAttempts = new SqliteRepairAttemptRepository(db);
    this.evalRuns = new SqliteEvalRunRepository(db);
    this.agentPipelines = new SqliteAgentPipelineRepository(
      db,
      this.agentProfiles,
      this.a2aRemoteAgents,
    );
    this.pipelineBackflows = new SqlitePipelineBackflowRepository(db);
    this.a2aRefinements = new SqliteA2ARefinementAttemptRepository(db);
  }

  withTransaction<T>(
    work: (state: ConversationTransactionGateway) => SynchronousTransactionResult<T>,
  ): T {
    // Do not even start an async callback: it could continue after rollback.
    if (types.isAsyncFunction(work)) {
      throw new TypeError("Transaction callbacks must be synchronous");
    }
    let active = true;
    const scoped = <A extends unknown[], R>(operation: (...args: A) => R) =>
      (...args: A): R => {
        if (!active) throw new Error("Transaction scope is no longer active");
        return operation(...args);
      };
    const state: ConversationTransactionGateway = {
      getThread: scoped((id) => this.threads.getSync(id)),
      createThread: scoped((input) => this.threads.createSync(normalizeThreadInput(input))),
      getTaskRun: scoped((id) => this.taskRuns.getSync(id)),
      createTaskRun: scoped((input) => {
        const normalized = normalizeTaskRunInput(input);
        if (!this.threads.getSync(input.threadId)) throw new Error(`Thread ${input.threadId} not found`);
        return this.taskRuns.createSync(normalized);
      }),
      setTaskRunStatus: scoped((id, status) => {
        const current = this.taskRuns.getSync(id);
        if (!current) throw new Error(`TaskRun ${id} not found`);
        assertTaskRunTransition(current.status, status);
        return current.status === status ? current : this.taskRuns.updateStatusSync(id, status, current.status);
      }),
      setTaskRunCurrentStep: scoped((id, stepId) => this.taskRuns.setCurrentStepSync(id, stepId)),
      createStep: scoped((input) => this.steps.createSync(input)),
      setStepStatus: scoped((id, status, patch) => this.steps.updateStatusSync(id, status, patch)),
      createCheckpoint: scoped((input) => this.checkpoints.createSync(input)),
      createApproval: scoped((input) => this.approvals.createSync({
        ...input,
        policyEvaluation: input.policyEvaluation ?? evaluateApprovalActionPolicy(input.actionType),
      })),
      createArtifact: scoped((input) => this.artifacts.createSync(input)),
    };
    try {
      // better-sqlite3 uses a savepoint for synchronous nested transactions.
      // No callback can yield while the shared connection owns this scope.
      return this.db.transaction(() => {
        const result = work(state);
        if (result !== null && (typeof result === "object" || typeof result === "function") &&
            "then" in result && typeof result.then === "function") {
          // Handle a rejected native Promise without allowing later access to
          // this scope. Foreign thenables are rejected without invoking them.
          if (types.isPromise(result)) void result.catch(() => {});
          throw new TypeError("Transaction callbacks must be synchronous");
        }
        return result;
      }).immediate();
    } finally {
      active = false;
    }
  }

  getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
    const dbPath =
      typeof (this.db as unknown as { name?: unknown }).name === "string"
        ? (this.db as unknown as { name: string }).name
        : "";
    const checkpoint = this.readWalCheckpoint();
    const mainBytes = statBytes(dbPath);
    const walBytes = statBytes(`${dbPath}-wal`);
    const shmBytes = statBytes(`${dbPath}-shm`);
    return {
      mainBytes,
      walBytes,
      shmBytes,
      totalBytes: mainBytes + walBytes + shmBytes,
      walCheckpoint: checkpoint,
    };
  }

  private readWalCheckpoint(): DatabaseDiagnosticsSnapshot["walCheckpoint"] {
    try {
      const row = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as
        | { busy?: unknown; log?: unknown; checkpointed?: unknown }
        | undefined;
      return {
        busy: finiteNumber(row?.busy),
        log: finiteNumber(row?.log),
        checkpointed: finiteNumber(row?.checkpointed),
      };
    } catch {
      return { busy: 0, log: 0, checkpointed: 0 };
    }
  }

  // -- Thread / TaskRun --------------------------------------------------

  async createThread(input: CreateThreadInput): Promise<Thread> {
    return this.threads.create(normalizeThreadInput(input));
  }

  async listThreads(): Promise<Thread[]> {
    return this.threads.list();
  }

  async listRecentTaskRuns(limit: number): Promise<RecentTaskRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("STATE_INVALID_INPUT: limit must be 1..100");
    const rows = this.db.prepare(
      `SELECT r.*, t.title AS thread_title,
        (SELECT contract_json FROM task_contracts WHERE task_run_id=r.id) AS contract_json
       FROM task_runs r JOIN threads t ON t.id=r.thread_id
       ORDER BY r.updated_at DESC,r.rowid DESC LIMIT ?`,
    ).all(limit) as (Parameters<typeof rowToTaskRun>[0] & { thread_title: string })[];
    return rows.map(row => ({ taskRun: rowToTaskRun(row), threadId: row.thread_id, threadTitle: row.thread_title }));
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
    // fall back to the latest non-template plan summary for older runs.
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
             AND a.uri NOT LIKE 'harness:plan/%'
             AND a.task_run_id IN (${placeholders})
             AND a.rowid = (
               SELECT a2.rowid
               FROM artifacts a2
               WHERE a2.kind = 'plan'
                 AND a2.uri NOT LIKE 'harness:plan/%'
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
    const normalized = normalizeTaskRunInput(input);
    const thread = await this.threads.get(input.threadId);
    if (!thread) throw new Error(`Thread ${input.threadId} not found`);
    return this.taskRuns.create(normalized);
  }

  async getTaskRun(id: string): Promise<TaskRun | null> {
    return this.taskRuns.get(id);
  }

  async setTaskRunStatus(id: string, status: TaskRunStatus): Promise<TaskRun> {
    const current = await this.taskRuns.get(id);
    if (!current) throw new Error(`TaskRun ${id} not found`);
    assertTaskRunTransition(current.status, status);
    if (current.status === status) return current;
    return this.taskRuns.updateStatus(id, status, current.status);
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

  async claimApprovalExecution(id: string, revision: number, token: string): Promise<Approval> {
    return this.approvals.claimExecution(id, revision, token);
  }

  async finishApprovalExecution(id: string, token: string, outcome: "succeeded" | "failed" | "uncertain"): Promise<void> {
    return this.approvals.finishExecution(id, token, outcome);
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

  async listDecisions(input: DecisionLogInput): Promise<DecisionLogPage> {
    return this.approvals.listAllWithDecisionTrace(input);
  }

  // -- Quality Gate -------------------------------------------------------

  async beginWorkspaceMutation(targetDir: string): Promise<string> {
    return this.workspaceMutations.begin(await resolveValidationWorkspaceKey(targetDir));
  }

  async endWorkspaceMutation(token: string): Promise<void> {
    await this.workspaceMutations.end(token);
  }

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

  /** Recheck both filesystem inputs and canonical execution state before use. */
  async assertQualityGateCurrent(gate: QualityGateResult): Promise<void> {
    const current = await this.getLatestQualityGateResult(gate.taskRunId);
    if (!current || current.id !== gate.id || current.status !== gate.status) throw qualityBlocked("Quality gate changed; evaluate the latest result");
    const validation = current.validationState;
    if (!validation) {
      if (current.buildPassed !== undefined || current.testsPassed !== undefined || current.smokePassed !== undefined) {
        throw qualityBlocked("Legacy quality checks have no execution/revision provenance; run the checks again");
      }
      return; // Plain answer gates do not assert code-check execution.
    }
    const task = await this.getTaskRun(gate.taskRunId);
    if (!task || validation.fingerprint === null) throw qualityBlocked("Workspace revision cannot be verified");
    this.assertValidationStateCurrent(gate.taskRunId, validation);
    const snapshot = await captureValidationRevision(task.targetDir);
    if (snapshot.workspaceKey !== validation.workspaceKey || snapshot.fingerprint === null || snapshot.fingerprint !== validation.fingerprint) {
      throw qualityBlocked("Workspace changed after quality evaluation; run the checks again");
    }
    this.assertValidationStateCurrent(gate.taskRunId, validation);
    const latest = await this.getLatestQualityGateResult(gate.taskRunId);
    if (!latest || latest.id !== gate.id || latest.status !== gate.status) throw qualityBlocked("Quality gate changed during freshness validation");
  }

  /** Applying a gate cannot overwrite a newer result or a user lifecycle action. */
  async applyQualityGateStatus(gate: QualityGateResult, status: "quality_failed" | "ready_for_review"): Promise<TaskRun> {
    return this.db.transaction(() => {
      const task = this.taskRuns.getSync(gate.taskRunId);
      if (!task) throw qualityBlocked("Task no longer exists");
      if (["paused", "done", "cancelled"].includes(task.status)) return task;
      const latest = this.db.prepare(`SELECT id,status,validation_state_json,build_passed,tests_passed,smoke_passed
        FROM quality_gate_results WHERE task_run_id=? ORDER BY rowid DESC LIMIT 1`)
        .get(gate.taskRunId) as { id: string; status: string; validation_state_json: string | null;
          build_passed: number | null; tests_passed: number | null; smoke_passed: number | null } | undefined;
      if (!latest || latest.id !== gate.id || latest.status !== gate.status ||
          (status === "quality_failed" ? latest.status !== "failed" : !["passed", "warning"].includes(latest.status))) return task;
      if (status === "ready_for_review") {
        if (latest.validation_state_json !== null) {
          const validation = JSON.parse(latest.validation_state_json) as NonNullable<QualityGateResult["validationState"]>;
          if (validation.fingerprint === null) return task;
          try { this.assertValidationStateCurrent(gate.taskRunId, validation); }
          catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "QUALITY_DONE_BLOCKED") return task;
            throw error;
          }
        } else if (latest.build_passed !== null || latest.tests_passed !== null || latest.smoke_passed !== null) return task;
      }
      assertTaskRunTransition(task.status, status);
      return this.taskRuns.updateStatusSync(task.id, status, task.status);
    }).immediate();
  }

  /** SQLite finalization never yields between ownership checks and done CAS. */
  async completeTaskRun(taskRunId: string, gateId: string): Promise<TaskRun> {
    return this.db.transaction(() => {
      const task = this.taskRuns.getSync(taskRunId);
      const gate = this.db.prepare(`SELECT * FROM quality_gate_results WHERE task_run_id=?
        ORDER BY rowid DESC LIMIT 1`).get(taskRunId) as {
          id: string; status: string; validation_state_json: string | null;
          build_passed: number | null; tests_passed: number | null; smoke_passed: number | null;
        } | undefined;
      if (!task || task.status !== "ready_for_review" || !gate || gate.id !== gateId || !["passed", "warning"].includes(gate.status)) {
        throw qualityBlocked("Task or quality gate changed before completion");
      }
      if (gate.status === "warning") {
        const suffix = `/${gateId}`;
        const consent = this.db.prepare(`SELECT 1 FROM artifacts WHERE task_run_id=? AND kind='quality_report'
          AND substr(uri,-?)=? LIMIT 1`).get(taskRunId, suffix.length, suffix);
        if (!consent) throw qualityBlocked("Warning-status gate requires current explicit known-risk approval");
      }
      if (gate.validation_state_json !== null) {
        const validation = JSON.parse(gate.validation_state_json) as NonNullable<QualityGateResult["validationState"]>;
        if (validation.fingerprint === null) throw qualityBlocked("Workspace revision cannot be verified");
        this.assertValidationStateCurrent(taskRunId, validation);
      } else if (gate.build_passed !== null || gate.tests_passed !== null || gate.smoke_passed !== null) {
        throw qualityBlocked("Legacy quality checks have no execution/revision provenance");
      }
      const unsettledApproval = this.db.prepare(`SELECT 1 FROM approvals WHERE task_run_id=? AND retry_approval_id IS NULL AND
        (execution_state IN ('running','uncertain') OR status='pending' OR
          (status IN ('approved','always_approved_for_run') AND action_type NOT IN ('capability_use','model_use'))) LIMIT 1`).get(taskRunId);
      const runningStep = this.db.prepare("SELECT 1 FROM steps WHERE task_run_id=? AND status='running' LIMIT 1").get(taskRunId);
      if (unsettledApproval || runningStep) throw qualityBlocked("Approval or execution has not settled");
      return this.taskRuns.updateStatusSync(taskRunId, "done", "ready_for_review");
    }).immediate();
  }

  private assertValidationStateCurrent(taskRunId: string, validation: NonNullable<QualityGateResult["validationState"]>): void {
    const workspace = this.workspaceMutations.getSync(validation.workspaceKey);
    const watermark = this.validationRuns.getWatermarkSync(taskRunId);
    if (workspace.activeMutations !== 0 || workspace.generation !== validation.generation || watermark !== validation.watermark) {
      throw qualityBlocked("Workspace or checker results changed after quality evaluation");
    }
  }

  /** Atomic result review and replacement consent; no runner or model call. */
  async prepareApprovalRetry(input: PrepareActionRetryInput): Promise<Approval> {
    if (!input || typeof input.reviewMessage !== "string" || !input.reviewMessage.trim() || input.reviewMessage.length > 4000) {
      throw new Error("APPROVAL_REVIEW_REQUIRED: 이전 실행 결과 검토 내용을 1~4000자로 기록하세요.");
    }
    return this.db.transaction(() => {
      const source = this.approvals.getSync(input.approvalId);
      if (!source) throw new Error("APPROVAL_NOT_FOUND");
      if (!Number.isSafeInteger(input.expectedRevision) || source.actionRevision !== input.expectedRevision) {
        throw new Error("APPROVAL_REVISION_MISMATCH");
      }
      if ((source.executionState ?? null) !== input.expectedExecutionState) {
        throw new Error("APPROVAL_REVIEW_REQUIRED: 이전 실행 상태가 변경되었습니다. 최신 결과를 검토하세요.");
      }
      const task = this.taskRuns.getSync(source.taskRunId);
      if (!task || task.status === "done" || task.status === "cancelled" || task.status === "paused") {
        throw new Error("APPROVAL_REVIEW_REQUIRED: 현재 작업 상태에서는 재시도를 준비할 수 없습니다.");
      }
      if (source.retryApprovalId) {
        const prepared = this.approvals.getSync(source.retryApprovalId);
        if (!prepared || prepared.taskRunId !== task.id) throw new Error("APPROVAL_REVIEW_REQUIRED: replacement is unavailable");
        return prepared;
      }
      if (!canReviewApprovalExecution(task.status, source.executionState)) {
        throw new Error("APPROVAL_REVIEW_REQUIRED: 실패 상태 또는 검토 대기 중인 불확실 실행만 재시도를 준비할 수 있습니다.");
      }
      if (source.executionState === "running" ||
          this.db.prepare("SELECT 1 FROM approvals WHERE task_run_id=? AND execution_state='running' LIMIT 1").get(task.id) ||
          this.db.prepare("SELECT 1 FROM steps WHERE task_run_id=? AND status='running' LIMIT 1").get(task.id) ||
          this.db.prepare("SELECT 1 FROM agent_invocations WHERE task_run_id=? AND status IN ('running','queued') LIMIT 1").get(task.id)) {
        throw new Error("APPROVAL_REVIEW_REQUIRED: 실행 중인 작업이 끝난 뒤 결과를 검토하세요.");
      }
      if (!["approved", "always_approved_for_run", "executed"].includes(source.status) ||
          !["file_write", "file_patch", "file_delete", "shell"].includes(source.actionType) ||
          !source.proposedAction || source.proposedAction.dbSnapshotExport ||
          !validateProposedActionDetails(source.proposedAction, source.actionType).ok ||
          source.policyEvaluation?.decision === "blocked" || taskContractBlocksAction(taskContractFor(task), source.actionType)) {
        throw new Error("APPROVAL_REVIEW_REQUIRED: 이 작업은 재시도 대상이 아닙니다. 세부 지정 또는 새 계획을 검토하세요.");
      }
      const index = (this.db.prepare("SELECT MAX(step_index) AS n FROM steps WHERE task_run_id=?").get(task.id) as { n: number | null }).n ?? -1;
      const step = this.steps.createSync({ taskRunId: task.id, index: index + 1, kind: "approval", title: "검토 후 재승인 대기", status: "pending" });
      const reviewMessage = redactSecrets(input.reviewMessage.trim());
      const checkpoint = this.checkpoints.createSync({ taskRunId: task.id, stepId: step.id, reason: "before_edit",
        stateRef: JSON.stringify({ retryOfApprovalId: source.id, sourceRevision: source.actionRevision,
          sourceExecutionState: source.executionState ?? null, sourceExecutionFinishedAt: source.executionFinishedAt ?? null, reviewMessage }),
        summary: `Reviewed retry of ${source.id}` });
      const next = this.approvals.createSync({ taskRunId: task.id, checkpointId: checkpoint.id, actionType: source.actionType,
        actionSummary: `재시도 검토: ${source.actionSummary}`, proposedAction: source.proposedAction, status: "pending",
        policyEvaluation: evaluateApprovalActionPolicy(source.actionType) });
      this.db.prepare("UPDATE approvals SET requires_manual_approval=1 WHERE id=?").run(next.id);
      this.db.prepare("UPDATE approvals SET retry_approval_id=? WHERE id=?").run(next.id, source.id);
      this.artifacts.createSync({ taskRunId: task.id, stepId: step.id, kind: "quality_report", title: "이전 실행 결과 검토",
        uri: `harness:approval-retry/${source.id}/${next.id}`, summary: reviewMessage });
      this.taskRuns.setCurrentStepSync(task.id, step.id);
      assertTaskRunTransition(task.status, "waiting_for_approval");
      this.taskRuns.updateStatusSync(task.id, "waiting_for_approval", task.status);
      return this.approvals.getSync(next.id)!;
    }).immediate();
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
    projectKey?: string;
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

  async summarizeLearningTraceCostByTaskRun(taskRunId: string) {
    return this.learningTraces.summarizeByTaskRun(taskRunId);
  }

  async aggregateLearningTraceCostByProfileAndDay(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
  }) {
    return this.learningTraces.aggregateByProfileAndDay(input);
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

  async summarizeAgentInvocationCostByTaskRun(taskRunId: string) {
    return this.agentInvocations.summarizeByTaskRun(taskRunId);
  }

  async sumAgentInvocationCostByTaskRun(taskRunId: string): Promise<number> {
    return this.agentInvocations.sumCostByTaskRun(taskRunId);
  }

  async aggregateAgentInvocationCostByProfileAndDay(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
  }) {
    return this.agentInvocations.aggregateByProfileAndDay(input);
  }

  async sumAgentInvocationCostByDay(input: {
    profileId?: string;
    isoDate: string;
  }): Promise<number> {
    return this.agentInvocations.sumCostByDay(input);
  }

  async summarizeAgentInvocationModelCosts(input: {
    sinceIso: string;
    untilIso: string;
    profileId?: string;
    limit?: number;
  }) {
    return this.agentInvocations.summarizeModelCosts(input);
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

  async writeDbSnapshot(targetPath: string): Promise<void> {
    this.db.prepare("VACUUM INTO ?").run(targetPath);
  }

  async buildThreadMarkdown(threadId: string): Promise<string | null> {
    const thread = await this.threads.get(threadId);
    if (!thread) return null;
    const taskRuns = await this.taskRuns.listByThread(threadId);
    const details = await Promise.all(
      taskRuns.map(async (taskRun) => ({
        taskRun,
        steps: await this.steps.listByTaskRun(taskRun.id),
        checkpoints: await this.checkpoints.listByTaskRun(taskRun.id),
        approvals: await this.approvals.listByTaskRun(taskRun.id),
        artifacts: await this.artifacts.listByTaskRun(taskRun.id),
      })),
    );
    return serializeThreadMarkdown({ thread, taskRuns: details });
  }
}

const normalizeThreadInput = (input: CreateThreadInput): CreateThreadInput => {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new Error("Thread title must be a non-empty string");
  }
  const payload: CreateThreadInput = { title: input.title.trim() };
  if (input.targetDir !== undefined) {
    const validation = validateAbsoluteTargetDir(input.targetDir);
    if (!validation.ok) throw new Error(`Invalid targetDir: ${validation.reason}`);
    payload.targetDir = validation.normalized;
  }
  if (typeof input.pipelineId === "string" && input.pipelineId.length > 0) {
    payload.pipelineId = input.pipelineId;
  }
  return payload;
};

const normalizeTaskRunInput = (input: CreateTaskRunInput): CreateTaskRunInput => {
  const validation = validateAbsoluteTargetDir(input.targetDir);
  if (!validation.ok) throw new Error(`Invalid targetDir: ${validation.reason}`);
  if (typeof input.userRequest !== "string" || input.userRequest.trim().length === 0) {
    throw new Error("userRequest must be a non-empty string");
  }
  return {
    threadId: input.threadId,
    userRequest: input.userRequest,
    targetDir: validation.normalized,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.followUpTaskRunId !== undefined ? { followUpTaskRunId: input.followUpTaskRunId } : {}),
    ...(input.status ? { status: input.status } : {}),
  };
};

const statBytes = (path: string): number => {
  if (!path || path === ":memory:") return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

const finiteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const qualityBlocked = (message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code: "QUALITY_DONE_BLOCKED" });

const isAgentPlanPlaceholder = (
  title: string | null,
  summary: string,
): boolean =>
  title === AGENT_PLAN_PLACEHOLDER_TITLE ||
  summary.startsWith(AGENT_PLAN_PLACEHOLDER_SUMMARY_PREFIX);
