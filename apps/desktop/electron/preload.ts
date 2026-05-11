import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  isAllowedChannel,
  isHarnessError,
  type AgentInvocation,
  type AgentProviderStatusMap,
  type AgentStreamEvent,
  type Approval,
  type Artifact,
  type Capability,
  type CapabilitySuggestion,
  type HarnessSettings,
  type SkillResources,
  type ConversationTaskDraft,
  type HarnessDesktopApi,
  type HarnessError,
  type HarnessResult,
  type LearnerRecommendation,
  type LearningTrace,
  type OrchestrationPlan,
  type OrchestrationRunResult,
  type QualityGateResult,
  type RepairPlanDraft,
  type RunnerResultPayload,
  type RuntimeInfo,
  type TaskRun,
  type TaskRunDetail,
  type Thread,
  type ThreadDetail,
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
    recommend: (input) =>
      invokeUnwrapped<LearnerRecommendation>(
        IPC_CHANNELS.learner.recommend,
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
  },
  settings: {
    get: () => invokeUnwrapped<HarnessSettings>(IPC_CHANNELS.settings.get),
    update: (input) =>
      invokeUnwrapped<HarnessSettings>(IPC_CHANNELS.settings.update, input),
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
  },
};

contextBridge.exposeInMainWorld("harness", harnessApi);
