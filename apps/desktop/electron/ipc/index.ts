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
import type { QualityEvaluator } from "@harness/quality";
import type {
  CapabilityRegistry,
  CapabilityService,
  SkillSourceConfig,
} from "@harness/skillify-adapter";
import type { LearnerAdvisor, TraceRecorder } from "@harness/learner";
import type { OrchestrationService } from "@harness/orchestration";
import type { AgentPlanningService } from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAppIpc } from "./app-ipc";
import { registerStateIpc } from "./state-ipc";
import { registerConversationIpc } from "./conversation-ipc";
import { registerRunnerIpc } from "./runner-ipc";
import { registerQualityIpc } from "./quality-ipc";
import { registerCapabilityIpc } from "./capability-ipc";
import { registerLearnerIpc } from "./learner-ipc";
import { registerOrchestrationIpc } from "./orchestration-ipc";
import { registerAgentIpc } from "./agent-ipc";
import { registerSettingsIpc } from "./settings-ipc";
import { registerAgentsIpc } from "./agents-ipc-register";
import { registerMcpIpc } from "./mcp-ipc-register";
import { registerSkillSourceIpc } from "./skill-source-ipc-register";
import { registerSecretIpc } from "./secret-ipc-register";
import { registerPipelineIpc } from "./pipeline-ipc-register";
import { registerRemoteAgentsIpc } from "./remote-agents-ipc-register";
import type { SkillRootPolicy } from "./skill-source-ipc";
import { eventBus } from "../event-bus";

export interface IpcContext {
  state: LocalStateService;
  conversation: ConversationService;
  runner: RunnerService;
  artifactStore: ArtifactStore;
  qualityEvaluator: QualityEvaluator;
  qualityCompletion: TaskRunCompletionService;
  capabilityService: CapabilityService;
  capabilityRegistry: CapabilityRegistry;
  skillSources: SkillSourceConfig[];
  learnerAdvisor: LearnerAdvisor;
  traceRecorder: TraceRecorder;
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
}

/**
 * Single registration entry point.
 */
export const registerAllIpc = (ctx: IpcContext): void => {
  registerAppIpc();
  registerStateIpc(ctx.state);
  registerConversationIpc(ctx.conversation, ctx.state, eventBus);
  registerRunnerIpc(ctx.runner, ctx.state, ctx.artifactStore, eventBus);
  registerQualityIpc(
    ctx.state,
    ctx.qualityEvaluator,
    ctx.qualityCompletion,
    eventBus,
  );
  registerCapabilityIpc(
    ctx.capabilityService,
    ctx.capabilityRegistry,
    ctx.skillSources,
    eventBus,
  );
  registerLearnerIpc(ctx.learnerAdvisor, ctx.traceRecorder, eventBus);
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
  registerMcpIpc({
    mcp: ctx.state.mcpServers,
    probe: ctx.mcpProbe,
  });
  registerSkillSourceIpc({
    skillSources: ctx.state.skillSources,
    pathPolicy: ctx.skillRootPolicy,
    capabilityRegistry: {
      refresh: async () => {
        // CapabilityRegistry.refresh takes the configured skill source
        // list and returns capabilities; surface a count for the UI.
        const caps = await ctx.capabilityRegistry.refresh(ctx.skillSources);
        return { skillCount: caps.length };
      },
    },
  });
  registerSecretIpc({ vault: ctx.secretVault });
};
