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
import type { OrchestrationService } from "@harness/orchestration";
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
import { registerRemoteAgentsIpc } from "./remote-agents-ipc-register";
import { registerEvalsIpc } from "./evals-ipc-register";
import type { SkillRootPolicy } from "./skill-source-ipc";
import {
  refreshGeneratedSkillSourceAfterRunner,
  refreshSkillSourceCapabilities,
} from "./skill-source-refresh";
import { eventBus } from "../event-bus";
import type { SystemDiagnosticsService } from "../services/system-diagnostics-service";

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
export const registerAllIpc = (ctx: IpcContext): void => {
  registerAppIpc({ diagnostics: ctx.diagnosticsService });
  registerStateIpc(ctx.state, eventBus);
  registerConversationIpc(
    ctx.conversation,
    ctx.state,
    eventBus,
    ctx.instinctService,
  );
  registerRunnerIpc(ctx.runner, ctx.state, ctx.artifactStore, eventBus, {
    afterExecuteApproved: ({ approvalId }) =>
      refreshGeneratedSkillSourceAfterRunner(ctx, approvalId),
  });
  registerShadowIpc({ shadow: ctx.shadowWorkspace }, eventBus);
  registerQualityIpc(
    ctx.state,
    ctx.qualityEvaluator,
    ctx.qualityCompletion,
    ctx.repairLoop,
    eventBus,
    ctx.instinctService,
  );
  registerCapabilityIpc(
    ctx.capabilityService,
    ctx.capabilityRegistry,
    ctx.skillSources,
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
  registerSettingsIpc(ctx.state, ctx.onSettingsUpdate);
  registerAgentsIpc({
    state: {
      profiles: ctx.state.agentProfiles,
      pipelines: ctx.state.agentPipelines,
      getSettings: () => ctx.state.getSettings(),
      updateSettings: (next) => ctx.state.updateSettings(next),
    },
  });
  registerPipelineIpc({ pipelines: ctx.state.agentPipelines });
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
};
