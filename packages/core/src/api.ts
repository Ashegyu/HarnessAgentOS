import type { RuntimeInfo } from "./runtime";
import type {
  Approval,
  AgentInvocation,
  AgentProvider,
  AgentProviderStatusMap,
  AgentStreamEvent,
  Artifact,
  Capability,
  CapabilitySuggestion,
  SkillResources,
  LearnerRecommendation,
  LearningTrace,
  OrchestrationMode,
  OrchestrationPlan,
  OrchestrationRunResult,
  ProposedActionDetails,
  QualityGateInput,
  QualityGateResult,
  RepairPlanDraft,
  Step,
  TaskRun,
  Thread,
  ThreadDetail,
  Checkpoint,
} from "./types";
import type {
  ApproveInput,
  ConversationTaskDraft,
  CreateConversationTaskInput,
  RedirectTaskInput,
  RejectApprovalInput,
} from "./conversation";

export interface TaskRunDetail {
  taskRun: ThreadDetail["taskRuns"][number];
  steps: Step[];
  approvals: Approval[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
  /**
   * Phase 8 — non-empty when this TaskRun was created with
   * `mode: "agent"` and at least one `agent.generatePlan` has run.
   * Sorted newest-first. Renderer uses presence + status of the head
   * entry to render the inline AgentPanel/AgentStreamView.
   */
  agentInvocations: AgentInvocation[];
}

export interface RunnerResultPayload {
  id: string;
  taskRunId: string;
  stepId: string;
  commandSummary: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  changedFiles?: string[];
  artifactIds: string[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Public IPC surface exposed to the renderer via contextBridge.
 * Single source of truth for method names is docs/contracts/ipc-contracts.md.
 */
export interface HarnessDesktopApi {
  app: {
    getVersion(): Promise<string>;
    getRuntimeInfo(): Promise<RuntimeInfo>;
    /** Returns null when the user cancels the dialog. */
    selectDirectory(): Promise<string | null>;
    /**
     * Native file picker, optionally rooted at `defaultDir` and allowing
     * the user to type/create a new file name (so file_write approvals
     * can target a not-yet-existent path). Returns the absolute file
     * path or null when the user cancels.
     */
    selectFile(input?: { defaultDir?: string }): Promise<string | null>;
  };
  state: {
    listThreads(): Promise<Thread[]>;
    getThread(input: { threadId: string }): Promise<ThreadDetail>;
    createThread(input: {
      title: string;
      targetDir?: string;
    }): Promise<Thread>;
  };
  conversation: {
    createTask(input: CreateConversationTaskInput): Promise<ConversationTaskDraft>;
    redirectTask(input: RedirectTaskInput): Promise<ConversationTaskDraft>;
    approve(input: ApproveInput): Promise<Approval>;
    rejectApproval(input: RejectApprovalInput): Promise<Approval>;
    getTaskRunDetail(input: { taskRunId: string }): Promise<TaskRunDetail>;
    setProposedAction(input: {
      approvalId: string;
      details: ProposedActionDetails;
    }): Promise<Approval>;
    pauseTask(input: { taskRunId: string }): Promise<TaskRun>;
    resumeTask(input: { taskRunId: string }): Promise<TaskRun>;
    cancelTask(input: { taskRunId: string; reason: string }): Promise<TaskRun>;
  };
  runner: {
    executeApproved(input: { approvalId: string }): Promise<RunnerResultPayload>;
    listArtifacts(input: { taskRunId: string }): Promise<Artifact[]>;
    readArtifact(input: {
      artifactId: string;
    }): Promise<{ artifact: Artifact; content: string }>;
    retryApproval(input: { approvalId: string }): Promise<RunnerResultPayload>;
  };
  quality: {
    evaluate(input: QualityGateInput): Promise<QualityGateResult>;
    getLatest(input: {
      taskRunId: string;
    }): Promise<QualityGateResult | null>;
    approveKnownRisks(input: {
      taskRunId: string;
      message: string;
    }): Promise<TaskRun>;
    createRepairPlan(input: {
      taskRunId: string;
      instruction?: string;
    }): Promise<RepairPlanDraft>;
    markReadyForReview(input: { taskRunId: string }): Promise<TaskRun>;
    markDone(input: { taskRunId: string }): Promise<TaskRun>;
  };
  capability: {
    list(): Promise<Capability[]>;
    refresh(): Promise<Capability[]>;
    suggest(input: {
      taskRunId: string;
      prompt: string;
    }): Promise<CapabilitySuggestion[]>;
    readSkill(input: {
      capabilityId: string;
    }): Promise<{
      capability: Capability;
      instructions: string;
      resources: SkillResources;
    }>;
    proposeScriptRun(input: {
      capabilityId: string;
      taskRunId: string;
      scriptName: string;
    }): Promise<Approval>;
  };
  learner: {
    getTrace(input: { taskRunId: string }): Promise<LearningTrace | null>;
    recommend(input: { taskRunId: string }): Promise<LearnerRecommendation>;
    recordSelection(input: {
      taskRunId: string;
      selectedModel?: string;
      selectedCapabilities?: string[];
    }): Promise<LearningTrace>;
    recordOutcome(input: {
      taskRunId: string;
      latencyMs?: number;
      costEstimate?: number;
      success?: boolean;
      failureReason?: string;
    }): Promise<LearningTrace>;
    recordDecision(input: {
      taskRunId: string;
      recommendationId: string;
      decision: "accepted" | "rejected";
      reason?: string;
    }): Promise<void>;
  };
  orchestration: {
    /** Returns null when the feature flag is off. */
    getPlan(input: {
      taskRunId: string;
    }): Promise<OrchestrationPlan | null>;
    draftPlan(input: {
      taskRunId: string;
      mode: OrchestrationMode;
      instruction?: string;
    }): Promise<{
      plan: OrchestrationPlan;
      artifact: Artifact;
      approval: Approval;
    }>;
    runApproved(input: {
      approvalId: string;
    }): Promise<OrchestrationRunResult>;
  };
  agent: {
    /**
     * Probe `claude --version` and `codex --version`. Result is cached
     * in-memory and not persisted in the DB.
     */
    checkProviders(): Promise<AgentProviderStatusMap>;
    /**
     * Start a CLI-backed planning run for a TaskRun previously created
     * with `mode: "agent"`. On success returns the invocation row, the
     * parsed plan artifact, and 0..N approval rows. 0 approvals is valid
     * (answer-only response per phase-08 §8).
     */
    generatePlan(input: {
      taskRunId: string;
      provider?: AgentProvider;
      model?: string;
      instruction?: string;
    }): Promise<{
      invocation: AgentInvocation;
      planArtifact: Artifact;
      approvals: Approval[];
    }>;
    cancelInvocation(input: { invocationId: string }): Promise<AgentInvocation>;
    retryInvocation(input: { invocationId: string }): Promise<{
      invocation: AgentInvocation;
      planArtifact: Artifact;
      approvals: Approval[];
    }>;
    useTemplateFallback(input: { taskRunId: string }): Promise<{
      planArtifact: Artifact;
      approvals: Approval[];
    }>;
  };
  events: {
    /**
     * Subscribe to TaskRun row changes pushed from the main process.
     * Returns an unsubscribe function the renderer must call on cleanup.
     */
    onTaskRunChanged(
      listener: (payload: { taskRunId: string }) => void,
    ): () => void;
    /**
     * Subscribe to streaming agent invocation events. Renderer must
     * filter by `invocationId` since events are broadcast to all windows.
     */
    onAgentStreamEvent(
      listener: (event: AgentStreamEvent) => void,
    ): () => void;
  };
}
