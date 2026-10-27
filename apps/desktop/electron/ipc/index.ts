import type {
  ArtifactStore,
  ConversationService,
  HarnessSettings,
  McpServerConfig,
  McpServerHealth,
  TaskRunCompletionService,
} from "@harness/core";
import type {
  LocalStateService,
  SecretVaultService,
} from "@harness/storage";
import type { RunnerService } from "@harness/runners";
import type { ShadowWorkspaceService } from "@harness/runners";
import type { QualityEvaluator, RepairLoopService } from "@harness/quality";
import type {
  CapabilityRegistry,
  CapabilityService,
  SkillSourceConfig,
} from "@harness/skillify-adapter";
import type {
  InstinctService,
  LearnerAdvisor,
  TopologyAdvisor,
  TraceRecorder,
} from "@harness/learner";
import {
  CodeChangeLoopService,
  HarnessPackageService,
  type OrchestrationService,
} from "@harness/orchestration";
import type { AgentPlanningService } from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAppIpc } from "./app-ipc";
import { registerStateIpc } from "./state-ipc";
import { registerConversationIpc } from "./conversation-ipc";
import { registerRunnerIpc } from "./runner-ipc";
import { registerShadowIpc } from "./shadow-ipc-register";
import { registerQualityIpc } from "./quality-ipc";
import { registerCapabilityIpc } from "./capability-ipc";
import { registerLearnerIpc } from "./learner-ipc";
import { registerTopologyIpc } from "./topology-ipc-register";
import { registerInstinctIpc } from "./instinct-ipc";
import { registerOrchestrationIpc } from "./orchestration-ipc";
import { registerAgentIpc } from "./agent-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerAgentsIpc } from "./agents-ipc-register";
import { registerMcpIpc } from "./mcp-ipc-register";
import { registerSkillSourceIpc } from "./skill-source-ipc-register";
import { registerSecretIpc } from "./secret-ipc-register";
import { registerPipelineIpc } from "./pipeline-ipc-register";
import { registerHarnessPackageIpc } from "./harness-package-ipc-register";
import { registerRemoteAgentsIpc } from "./remote-agents-ipc-register";
import { registerEvalsIpc } from "./evals-ipc-register";
import type { SkillRootPolicy } from "./skill-source-ipc";
import {
  refreshGeneratedSkillSourceAfterRunner,
  refreshSkillSourceCapabilities,
} from "./skill-source-refresh";
import { executeA2ARefinementApproval } from "../a2a-refinement-approval-executor";
import { eventBus, setTaskRunChangedObserver } from "../event-bus";
import { PipelineBackflowService } from "../pipeline-backflow-service";
import type { SystemDiagnosticsService } from "../services/system-diagnostics-service";
import { AutomaticQualityService } from "../services/automatic-quality-service";
import { createTaskProgressionHost } from "../services/task-progression-host";
import { ConversationStartService } from "../services/conversation-start-service";

export interface IpcContext {
  state: LocalStateService;
  conversation: ConversationService;
  runner: RunnerService;
  shadowWorkspace: ShadowWorkspaceService;
  artifactStore: ArtifactStore;
  qualityEvaluator: QualityEvaluator;
  qualityCompletion: TaskRunCompletionService;
  repairLoop: RepairLoopService;
  capabilityService: CapabilityService;
  capabilityRegistry: CapabilityRegistry;
  skillSources: SkillSourceConfig[];
  learnerAdvisor: LearnerAdvisor;
  topologyAdvisor: TopologyAdvisor;
  traceRecorder: TraceRecorder;
  instinctService: InstinctService;
  orchestrationService: OrchestrationService;
  agentPlanning: AgentPlanningService;
  probeAgentProviders: () => Promise<AgentProviderStatusMap>;
  onSettingsUpdate?: (s: HarnessSettings) => void;
  /** SecretVault wired with the Electron safeStorage backend at boot. */
  secretVault: SecretVaultService;
  /** Hook used by the skillSource IPC to keep path-policy in sync. */
  skillRootPolicy: SkillRootPolicy;
  /** Phase 4 will plug a real http/stdio prober here. */
  mcpProbe: (server: McpServerConfig) => Promise<McpServerHealth>;
  diagnosticsService: SystemDiagnosticsService;
}

/**
 * Single registration entry point.
 */
export const registerAllIpc = (ctx: IpcContext): { shutdown(): Promise<void> } => {
  const codeChangeLoop = new CodeChangeLoopService({
    state: ctx.state,
    runner: {
      executeApproved: async (approvalId) => {
        const result = await ctx.runner.executeApproved(approvalId);
        await refreshGeneratedSkillSourceAfterRunner(ctx, approvalId);
        return result;
      },
    },
  });
  const pipelineBackflow = new PipelineBackflowService({
    state: ctx.state,
    orchestration: ctx.orchestrationService,
    agentPlanning: ctx.agentPlanning,
    onTaskRunChanged: (taskRunId) => eventBus.taskRunChanged(taskRunId),
  });
  const automaticQuality = new AutomaticQualityService({
    state: ctx.state,
    evaluator: ctx.qualityEvaluator,
    completion: ctx.qualityCompletion,
    onQualityGate: async (result) => {
      await ctx.instinctService.recordQualityGate(result);
    },
    onQualityFailure: async (result) => {
      await pipelineBackflow.runForQualityFailure(result);
    },
    onTaskRunChanged: (taskRunId) =>
      eventBus.taskRunChanged(taskRunId, { skipAutomaticQuality: true }),
    onError: (taskRunId, error) => {
      console.error(`[harness:auto-quality] ${taskRunId}`, error);
    },
  });
  const progression = createTaskProgressionHost({
    state: ctx.state,
    conversation: ctx.conversation,
    execute: async approval => {
      if (approval.actionType === "orchestration_plan") {
        return ctx.orchestrationService.runApproved({ approvalId: approval.id });
      }
      const override = await executeA2ARefinementApproval({
        state: ctx.state, approvalId: approval.id,
        emitStreamEvent: event => eventBus.agentStreamEvent(event),
      });
      const result = override ?? await ctx.runner.executeApproved(approval.id);
      try { await refreshGeneratedSkillSourceAfterRunner(ctx, approval.id); }
      catch { /* Advisory registry refresh cannot turn a successful write into a retry. */ }
      return result;
    },
    evaluateQuality: taskRunId => automaticQuality.evaluateIfReady(taskRunId),
    resumeBackflow: taskRunId => pipelineBackflow.resumePending(taskRunId),
    resumePlanning: async taskRunId => {
      const settings = await ctx.state.getSettings();
      return ctx.agentPlanning.generatePlan({ taskRunId,
        timeoutMs: settings.agent.timeoutMs, stallTimeoutMs: settings.agent.stallTimeoutMs });
    },
    changed: taskRunId => eventBus.taskRunChanged(taskRunId, { skipAutomaticQuality: true }),
    onError: (taskRunId, error) => console.error(`[harness:progression] ${taskRunId}`, error),
  });
  // Remember only tasks touched this process. Changing settings must not silently
  // start historical pending tasks from a previous session.
  const activeTaskRunIds = new Set<string>();
  setTaskRunChangedObserver(taskRunId => {
    activeTaskRunIds.add(taskRunId);
    progression.schedule(taskRunId);
  });
  registerAppIpc({ diagnostics: ctx.diagnosticsService });
  const startService = new ConversationStartService({
    createTask: input => ctx.conversation.createTask(input),
    hold: id => progression.hold(id),
    getTaskRun: id => ctx.state.getTaskRun(id),
    proposeCapabilities: async taskRunId => {
      const [task, settings, profiles] = await Promise.all([
        ctx.state.getTaskRun(taskRunId), ctx.state.getSettings(), ctx.state.agentProfiles.list(),
      ]);
      if (!task) return;
      const profile = profiles.find(p => p.id === settings.activeAgentProfileId) ?? profiles.find(p => p.isDefault);
      return ctx.capabilityService.proposeCandidateApprovals({ taskRunId, prompt: task.userRequest, profileId: profile?.id ?? null });
    },
    proposeRecommendation: taskRunId => ctx.learnerAdvisor.proposeRecommendationApprovals({ taskRunId }),
    draftOrchestration: input => ctx.orchestrationService.draftPlan(input),
    markPlanningReady: taskRunId => ctx.state.createArtifact({ taskRunId, kind: "snapshot",
      title: "AI 실행 준비 완료", uri: `harness:planning-ready/${taskRunId}`,
      summary: "추천 후보 준비가 끝났습니다. 승인/거절 결정 후 메인에서 AI를 시작합니다." }),
    changed: id => eventBus.taskRunChanged(id),
    fail: (id, error) => progression.fail(id, error),
    onError: (id, error) => console.error(`[harness:start] ${id}`, error),
  });
  registerStateIpc(ctx.state, eventBus);
  registerConversationIpc(
    ctx.conversation,
    ctx.state,
    eventBus,
    ctx.instinctService,
    ctx.agentPlanning,
    startService,
    ctx.runner,
  );
  registerRunnerIpc(ctx.runner, ctx.state, ctx.artifactStore, eventBus, {
    executeApprovedOverride: ({ approvalId }) =>
      executeA2ARefinementApproval({
        state: ctx.state,
        approvalId,
        emitStreamEvent: (event) => eventBus.agentStreamEvent(event),
      }),
    afterExecuteApproved: ({ approvalId }) =>
      refreshGeneratedSkillSourceAfterRunner(ctx, approvalId),
    executeCodeChangeAttempt: (input) => codeChangeLoop.runAttempt(input),
  });
  registerShadowIpc({ shadow: ctx.shadowWorkspace }, eventBus);
  registerQualityIpc(
    ctx.state,
    ctx.qualityEvaluator,
    ctx.qualityCompletion,
    ctx.repairLoop,
    eventBus,
    ctx.instinctService,
    pipelineBackflow,
  );
  registerCapabilityIpc(
    ctx.capabilityService,
    ctx.capabilityRegistry,
    eventBus,
  );
  registerLearnerIpc(ctx.learnerAdvisor, ctx.traceRecorder, eventBus);
  registerTopologyIpc(ctx.topologyAdvisor);
  registerInstinctIpc(ctx.instinctService);
  registerOrchestrationIpc(ctx.orchestrationService, eventBus);
  registerAgentIpc(
    {
      planning: ctx.agentPlanning,
      conversation: ctx.conversation,
      state: ctx.state,
      probeProviders: ctx.probeAgentProviders,
    },
    eventBus,
  );
  registerSettingsIpc(ctx.state, settings => {
    ctx.onSettingsUpdate?.(settings);
    for (const taskRunId of activeTaskRunIds) progression.schedule(taskRunId);
  });
  registerAgentsIpc({
    state: {
      profiles: ctx.state.agentProfiles,
      pipelines: ctx.state.agentPipelines,
      harnessBindingSets: ctx.state.harnessBindingSets,
      getSettings: () => ctx.state.getSettings(),
      updateSettings: (next) => ctx.state.updateSettings(next),
    },
  });
  registerPipelineIpc({ pipelines: ctx.state.agentPipelines });
  registerHarnessPackageIpc({
    harnessPackages: new HarnessPackageService({ state: ctx.state }),
  });
  registerRemoteAgentsIpc({ remoteAgents: ctx.state.a2aRemoteAgents });
  registerEvalsIpc({
    evalRuns: ctx.state.evalRuns,
    agentInvocations: ctx.state.agentInvocations,
  });
  registerMcpIpc({
    state: ctx.state,
    mcp: ctx.state.mcpServers,
    profiles: ctx.state.agentProfiles,
    probe: ctx.mcpProbe,
    listSecretKeys: () => ctx.secretVault.listKeys(),
  });
  registerSkillSourceIpc({
    state: ctx.state,
    skillSources: ctx.state.skillSources,
    pathPolicy: ctx.skillRootPolicy,
    capabilityRegistry: {
      refresh: async (source) => refreshSkillSourceCapabilities(ctx, source),
    },
  });
  registerSecretIpc({ vault: ctx.secretVault });
  return { shutdown: async () => {
    const outcomes = await Promise.allSettled([
      progression.shutdown(), startService.shutdown(), automaticQuality.shutdown(), pipelineBackflow.shutdown(),
    ]);
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } };
};
