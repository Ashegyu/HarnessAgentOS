import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  isAllowedChannel,
  isHarnessError,
  type AgentInvocation,
  type AgentProviderStatusMap,
  type AgentStreamEvent,
  type A2AAgentCardSnapshot,
  type A2AEndpoint,
  type A2ARefinementActivityPage,
  type A2ARefinementAttempt,
  type A2ARegistryEntry,
  type Approval,
  type Artifact,
  type BudgetUsageSummary,
  type Capability,
  type CapabilityCandidateApprovalResult,
  type CapabilitySuggestion,
  type EvolutionCandidate,
  type DecisionLogPage,
  type EvalCostTrendFilters,
  type EvalCostTrendView,
  type EvalRunDetailView,
  type EvalRunListFilters,
  type EvalRunListItem,
  type ExportApprovalResult,
  type HarnessSettings,
  type Instinct,
  type SkillResources,
  type ConversationTaskDraft,
  type HarnessDesktopApi,
  type HarnessError,
  type HarnessResult,
  type LearnerRecommendationApprovalResult,
  type LearnerRecommendation,
  type LearningTrace,
  type OrchestrationPlan,
  type OrchestrationRunResult,
  type PipelineBackflowActivityPage,
  type QualityGateResult,
  type RepairPlanDraft,
  type RunnerCancelExecutionResult,
  type RunnerResultPayload,
  type RuntimeInfo,
  type RuntimeLatencyFilters,
  type RuntimeLatencySummary,
  type ShadowPreview,
  type SystemDiagnostics,
  type TaskRun,
  type TaskRunCostSummary,
  type TaskRunDetail,
  type Thread,
  type ThreadDetail,
  type TopologyRecommendation,
} from "@harness/core";

const invokeUnwrapped = async <T>(
  channel: string,
  payload?: unknown,
): Promise<T> => {
  if (!isAllowedChannel(channel)) {
    throw asHarnessThrowable({
      code: "IPC_CHANNEL_NOT_ALLOWED",
      message: `IPC channel ${channel} is not on the allowlist`,
    });
  }
  const raw =
    payload === undefined
      ? ((await ipcRenderer.invoke(channel)) as HarnessResult<T> | undefined)
      : ((await ipcRenderer.invoke(channel, payload)) as
          | HarnessResult<T>
          | undefined);
  if (!raw || typeof raw !== "object" || !("ok" in raw)) {
    throw asHarnessThrowable({
      code: "IPC_INVALID_PAYLOAD",
      message: `Channel ${channel} returned an unexpected payload`,
    });
  }
  if (raw.ok) return raw.value;
  const e: HarnessError = isHarnessError(raw.error)
    ? raw.error
    : { code: "IPC_INVALID_PAYLOAD", message: "Unknown IPC failure" };
  throw asHarnessThrowable(e);
};

const asHarnessThrowable = (error: HarnessError): Error => {
  const e = new Error(`[${error.code}] ${error.message}`);
  (e as Error & { harnessError: HarnessError }).harnessError = error;
  return e;
};

const harnessApi: HarnessDesktopApi = {
  app: {
    getVersion: () => invokeUnwrapped<string>(IPC_CHANNELS.app.getVersion),
    getRuntimeInfo: () =>
      invokeUnwrapped<RuntimeInfo>(IPC_CHANNELS.app.getRuntimeInfo),
    getDiagnostics: () =>
      invokeUnwrapped<SystemDiagnostics>(IPC_CHANNELS.app.getDiagnostics),
    selectDirectory: () =>
      invokeUnwrapped<string | null>(IPC_CHANNELS.app.selectDirectory),
    selectFile: (input) =>
      invokeUnwrapped<string | null>(IPC_CHANNELS.app.selectFile, input ?? {}),
  },
  state: {
    listThreads: () =>
      invokeUnwrapped<Thread[]>(IPC_CHANNELS.state.listThreads),
    getThread: (input) =>
      invokeUnwrapped<ThreadDetail>(IPC_CHANNELS.state.getThread, input),
    createThread: (input) =>
      invokeUnwrapped<Thread>(IPC_CHANNELS.state.createThread, input),
    deleteThread: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.state.deleteThread, input);
    },
    exportDbSnapshot: (input) =>
      invokeUnwrapped<ExportApprovalResult>(
        IPC_CHANNELS.state.exportDbSnapshot,
        input,
      ),
    exportThreadMarkdown: (input) =>
      invokeUnwrapped<ExportApprovalResult>(
        IPC_CHANNELS.state.exportThreadMarkdown,
        input,
      ),
  },
  conversation: {
    createTask: (input) =>
      invokeUnwrapped<ConversationTaskDraft>(
        IPC_CHANNELS.conversation.createTask,
        input,
      ),
    redirectTask: (input) =>
      invokeUnwrapped<ConversationTaskDraft>(
        IPC_CHANNELS.conversation.redirectTask,
        input,
      ),
    approve: (input) =>
      invokeUnwrapped<Approval>(IPC_CHANNELS.conversation.approve, input),
    rejectApproval: (input) =>
      invokeUnwrapped<Approval>(
        IPC_CHANNELS.conversation.rejectApproval,
        input,
      ),
    getTaskRunDetail: (input) =>
      invokeUnwrapped<TaskRunDetail>(
        IPC_CHANNELS.conversation.getTaskRunDetail,
        input,
      ),
    listDecisions: (input) =>
      invokeUnwrapped<DecisionLogPage>(
        IPC_CHANNELS.conversation.listDecisions,
        input,
      ),
    listRefinementEvents: (input) =>
      invokeUnwrapped<A2ARefinementActivityPage>(
        IPC_CHANNELS.conversation.listRefinementEvents,
        input,
      ),
    listBackflowEvents: (input) =>
      invokeUnwrapped<PipelineBackflowActivityPage>(
        IPC_CHANNELS.conversation.listBackflowEvents,
        input,
      ),
    setProposedAction: (input) =>
      invokeUnwrapped<Approval>(
        IPC_CHANNELS.conversation.setProposedAction,
        input,
      ),
    pauseTask: (input) =>
      invokeUnwrapped<TaskRun>(IPC_CHANNELS.conversation.pauseTask, input),
    resumeTask: (input) =>
      invokeUnwrapped<TaskRun>(IPC_CHANNELS.conversation.resumeTask, input),
    cancelTask: (input) =>
      invokeUnwrapped<TaskRun>(IPC_CHANNELS.conversation.cancelTask, input),
    deleteTask: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.conversation.deleteTask, input);
    },
  },
  runner: {
    executeApproved: (input) =>
      invokeUnwrapped<RunnerResultPayload>(
        IPC_CHANNELS.runner.executeApproved,
        input,
      ),
    cancelExecution: (input) =>
      invokeUnwrapped<RunnerCancelExecutionResult>(
        IPC_CHANNELS.runner.cancelExecution,
        input,
      ),
    listArtifacts: (input) =>
      invokeUnwrapped<Artifact[]>(IPC_CHANNELS.runner.listArtifacts, input),
    readArtifact: (input) =>
      invokeUnwrapped<{ artifact: Artifact; content: string }>(
        IPC_CHANNELS.runner.readArtifact,
        input,
      ),
    retryApproval: (input) =>
      invokeUnwrapped<RunnerResultPayload>(
        IPC_CHANNELS.runner.retryApproval,
        input,
      ),
  },
  shadow: {
    createPreview: (input) =>
      invokeUnwrapped<ShadowPreview>(IPC_CHANNELS.shadow.createPreview, input),
  },
  quality: {
    evaluate: (input) =>
      invokeUnwrapped<QualityGateResult>(
        IPC_CHANNELS.quality.evaluate,
        input,
      ),
    getLatest: (input) =>
      invokeUnwrapped<QualityGateResult | null>(
        IPC_CHANNELS.quality.getLatest,
        input,
      ),
    approveKnownRisks: (input) =>
      invokeUnwrapped<TaskRun>(
        IPC_CHANNELS.quality.approveKnownRisks,
        input,
      ),
    createRepairPlan: (input) =>
      invokeUnwrapped<RepairPlanDraft>(
        IPC_CHANNELS.quality.createRepairPlan,
        input,
      ),
    markReadyForReview: (input) =>
      invokeUnwrapped<TaskRun>(
        IPC_CHANNELS.quality.markReadyForReview,
        input,
      ),
    markDone: (input) =>
      invokeUnwrapped<TaskRun>(IPC_CHANNELS.quality.markDone, input),
  },
  capability: {
    list: () =>
      invokeUnwrapped<Capability[]>(IPC_CHANNELS.capability.list),
    refresh: () =>
      invokeUnwrapped<Capability[]>(IPC_CHANNELS.capability.refresh),
    suggest: (input) =>
      invokeUnwrapped<CapabilitySuggestion[]>(
        IPC_CHANNELS.capability.suggest,
        input,
      ),
    proposeCandidates: (input) =>
      invokeUnwrapped<CapabilityCandidateApprovalResult>(
        IPC_CHANNELS.capability.proposeCandidates,
        input,
      ),
    readSkill: (input) =>
      invokeUnwrapped<{
        capability: Capability;
        instructions: string;
        resources: SkillResources;
      }>(IPC_CHANNELS.capability.readSkill, input),
    proposeScriptRun: (input) =>
      invokeUnwrapped<Approval>(
        IPC_CHANNELS.capability.proposeScriptRun,
        input,
      ),
  },
  learner: {
    getTrace: (input) =>
      invokeUnwrapped<LearningTrace | null>(
        IPC_CHANNELS.learner.getTrace,
        input,
      ),
    summarizeTaskRunCost: (input) =>
      invokeUnwrapped<TaskRunCostSummary>(
        IPC_CHANNELS.learner.summarizeTaskRunCost,
        input,
      ),
    summarizeBudgetUsage: (input) =>
      invokeUnwrapped<BudgetUsageSummary>(
        IPC_CHANNELS.learner.summarizeBudgetUsage,
        input,
      ),
    recommend: (input) =>
      invokeUnwrapped<LearnerRecommendation>(
        IPC_CHANNELS.learner.recommend,
        input,
      ),
    proposeRecommendation: (input) =>
      invokeUnwrapped<LearnerRecommendationApprovalResult>(
        IPC_CHANNELS.learner.proposeRecommendation,
        input,
      ),
    recordSelection: (input) =>
      invokeUnwrapped<LearningTrace>(
        IPC_CHANNELS.learner.recordSelection,
        input,
      ),
    recordOutcome: (input) =>
      invokeUnwrapped<LearningTrace>(
        IPC_CHANNELS.learner.recordOutcome,
        input,
      ),
    recordDecision: async (input) => {
      await invokeUnwrapped<null>(IPC_CHANNELS.learner.recordDecision, input);
    },
  },
  topology: {
    recommend: (input) =>
      invokeUnwrapped<TopologyRecommendation[]>(
        IPC_CHANNELS.topology.recommend,
        input,
      ),
    recordFeedback: async (input) => {
      await invokeUnwrapped<null>(
        IPC_CHANNELS.topology.recordFeedback,
        input,
      );
    },
  },
  instinct: {
    list: (input) =>
      invokeUnwrapped<Instinct[]>(IPC_CHANNELS.instinct.list, input ?? {}),
    listCandidates: (input) =>
      invokeUnwrapped<EvolutionCandidate[]>(
        IPC_CHANNELS.instinct.listCandidates,
        input ?? {},
      ),
    approveCandidate: (input) =>
      invokeUnwrapped<Instinct>(
        IPC_CHANNELS.instinct.approveCandidate,
        input,
      ),
    rejectCandidate: (input) =>
      invokeUnwrapped<EvolutionCandidate>(
        IPC_CHANNELS.instinct.rejectCandidate,
        input,
      ),
    disable: (input) =>
      invokeUnwrapped<Instinct>(IPC_CHANNELS.instinct.disable, input),
  },
  orchestration: {
    getPlan: (input) =>
      invokeUnwrapped<OrchestrationPlan | null>(
        IPC_CHANNELS.orchestration.getPlan,
        input,
      ),
    draftPlan: (input) =>
      invokeUnwrapped<{
        plan: OrchestrationPlan;
        artifact: Artifact;
        approval: Approval;
      }>(IPC_CHANNELS.orchestration.draftPlan, input),
    runApproved: (input) =>
      invokeUnwrapped<OrchestrationRunResult>(
        IPC_CHANNELS.orchestration.runApproved,
        input,
      ),
  },
  agent: {
    checkProviders: () =>
      invokeUnwrapped<AgentProviderStatusMap>(
        IPC_CHANNELS.agent.checkProviders,
      ),
    generatePlan: (input) =>
      invokeUnwrapped<{
        invocation: AgentInvocation;
        planArtifact: Artifact;
        approvals: Approval[];
      }>(IPC_CHANNELS.agent.generatePlan, input),
    cancelInvocation: (input) =>
      invokeUnwrapped<AgentInvocation>(
        IPC_CHANNELS.agent.cancelInvocation,
        input,
      ),
    retryInvocation: (input) =>
      invokeUnwrapped<{
        invocation: AgentInvocation;
        planArtifact: Artifact;
        approvals: Approval[];
      }>(IPC_CHANNELS.agent.retryInvocation, input),
    useTemplateFallback: (input) =>
      invokeUnwrapped<{ planArtifact: Artifact; approvals: Approval[] }>(
        IPC_CHANNELS.agent.useTemplateFallback,
        input,
      ),
    requestRefinement: (input) =>
      invokeUnwrapped<{ attempt: A2ARefinementAttempt; approval: Approval }>(
        IPC_CHANNELS.agent.requestRefinement,
        input,
      ),
  },
  settings: {
    get: () => invokeUnwrapped<HarnessSettings>(IPC_CHANNELS.settings.get),
    update: (input) =>
      invokeUnwrapped<HarnessSettings>(IPC_CHANNELS.settings.update, input),
  },
  evals: {
    listRuns: (input) =>
      invokeUnwrapped<EvalRunListItem[]>(
        IPC_CHANNELS.evals.listRuns,
        input ?? {},
      ),
    getRun: (input) =>
      invokeUnwrapped<EvalRunDetailView>(IPC_CHANNELS.evals.getRun, input),
    getCostTrend: (input) =>
      invokeUnwrapped<EvalCostTrendView>(
        IPC_CHANNELS.evals.getCostTrend,
        input ?? {},
      ),
    getRuntimeLatencySummary: (input) =>
      invokeUnwrapped<RuntimeLatencySummary[]>(
        IPC_CHANNELS.evals.getRuntimeLatencySummary,
        input ?? {},
      ),
  },
  // Settings/admin namespaces are implemented in main-process IPC handlers.
  // Keep the preload layer thin: it unwraps HarnessResult and exposes only
  // the typed window.harness facade, never raw ipcRenderer.
  agents: {
    list: () => invokeUnwrapped(IPC_CHANNELS.agents.list),
    get: (input) => invokeUnwrapped(IPC_CHANNELS.agents.get, input),
    create: (input) => invokeUnwrapped(IPC_CHANNELS.agents.create, input),
    update: (input) => invokeUnwrapped(IPC_CHANNELS.agents.update, input),
    delete: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.agents.delete, input);
    },
    setDefault: (input) =>
      invokeUnwrapped(IPC_CHANNELS.agents.setDefault, input),
    setActive: (input) =>
      invokeUnwrapped(IPC_CHANNELS.agents.setActive, input),
  },
  mcp: {
    list: () => invokeUnwrapped(IPC_CHANNELS.mcp.list),
    generateServerDraft: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.generateServerDraft, input),
    generateServerScaffoldDraft: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.generateServerScaffoldDraft, input),
    proposeServerScaffold: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.proposeServerScaffold, input),
    generateProfileBindingProposal: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.generateProfileBindingProposal, input),
    applyProfileBindingProposal: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.applyProfileBindingProposal, input),
    upsert: (input) => invokeUnwrapped(IPC_CHANNELS.mcp.upsert, input),
    delete: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.mcp.delete, input);
    },
    toggle: (input) => invokeUnwrapped(IPC_CHANNELS.mcp.toggle, input),
    healthCheck: (input) =>
      invokeUnwrapped(IPC_CHANNELS.mcp.healthCheck, input),
  },
  skillSource: {
    list: () => invokeUnwrapped(IPC_CHANNELS.skillSource.list),
    add: (input) => invokeUnwrapped(IPC_CHANNELS.skillSource.add, input),
    update: (input) => invokeUnwrapped(IPC_CHANNELS.skillSource.update, input),
    remove: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.skillSource.remove, input);
    },
    refresh: (input) =>
      invokeUnwrapped(IPC_CHANNELS.skillSource.refresh, input),
    generateSkillDraft: (input) =>
      invokeUnwrapped(IPC_CHANNELS.skillSource.generateSkillDraft, input),
    previewSkillDraft: (input) =>
      invokeUnwrapped(IPC_CHANNELS.skillSource.previewSkillDraft, input),
    proposeSkillFile: (input) =>
      invokeUnwrapped(IPC_CHANNELS.skillSource.proposeSkillFile, input),
    generateProfileBindingProposal: (input) =>
      invokeUnwrapped(
        IPC_CHANNELS.skillSource.generateProfileBindingProposal,
        input,
      ),
    applyProfileBindingProposal: (input) =>
      invokeUnwrapped(
        IPC_CHANNELS.skillSource.applyProfileBindingProposal,
        input,
      ),
  },
  secret: {
    write: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.secret.write, input);
    },
    clear: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.secret.clear, input);
    },
    listKeys: () => invokeUnwrapped(IPC_CHANNELS.secret.listKeys),
  },
  pipeline: {
    list: () => invokeUnwrapped(IPC_CHANNELS.pipeline.list),
    get: (input) => invokeUnwrapped(IPC_CHANNELS.pipeline.get, input),
    create: (input) => invokeUnwrapped(IPC_CHANNELS.pipeline.create, input),
    update: (input) => invokeUnwrapped(IPC_CHANNELS.pipeline.update, input),
    delete: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.pipeline.delete, input);
    },
  },
  remoteAgents: {
    list: () =>
      invokeUnwrapped<A2ARegistryEntry[]>(IPC_CHANNELS.remoteAgents.list),
    get: (input) =>
      invokeUnwrapped<A2ARegistryEntry>(IPC_CHANNELS.remoteAgents.get, input),
    upsertEndpoint: (input) =>
      invokeUnwrapped<A2AEndpoint>(
        IPC_CHANNELS.remoteAgents.upsertEndpoint,
        input,
      ),
    delete: async (input) => {
      await invokeUnwrapped<void>(IPC_CHANNELS.remoteAgents.delete, input);
    },
    toggle: (input) =>
      invokeUnwrapped<A2AEndpoint>(IPC_CHANNELS.remoteAgents.toggle, input),
    upsertCardSnapshot: (input) =>
      invokeUnwrapped<A2AAgentCardSnapshot>(
        IPC_CHANNELS.remoteAgents.upsertCardSnapshot,
        input,
      ),
  },
  events: {
    onTaskRunChanged: (listener) => {
      const channel = IPC_CHANNELS.events.taskRunChanged;
      const handler = (
        _e: IpcRendererEvent,
        payload: { taskRunId: string },
      ): void => {
        if (
          payload &&
          typeof payload === "object" &&
          typeof payload.taskRunId === "string"
        ) {
          listener({ taskRunId: payload.taskRunId });
        }
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.off(channel, handler);
      };
    },
    onAgentStreamEvent: (listener) => {
      const channel = IPC_CHANNELS.events.agentStreamEvent;
      const handler = (
        _e: IpcRendererEvent,
        payload: AgentStreamEvent,
      ): void => {
        if (
          payload &&
          typeof payload === "object" &&
          typeof (payload as { type?: unknown }).type === "string" &&
          typeof (payload as { invocationId?: unknown }).invocationId === "string"
        ) {
          listener(payload);
        }
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.off(channel, handler);
      };
    },
    onDiagnosticsChanged: (listener) => {
      const channel = IPC_CHANNELS.events.diagnosticsHeartbeat;
      const handler = (
        _e: IpcRendererEvent,
        payload: SystemDiagnostics,
      ): void => {
        if (
          payload &&
          typeof payload === "object" &&
          typeof (payload as { generatedAt?: unknown }).generatedAt === "string"
        ) {
          listener(payload);
        }
      };
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.off(channel, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("harness", harnessApi);
