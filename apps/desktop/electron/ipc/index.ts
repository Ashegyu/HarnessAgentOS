import type {
  ArtifactStore,
  ConversationService,
  HarnessSettings,
  McpServerConfig,
  McpServerHealth,
  SkillSource,
  TaskRunCompletionService,
} from "@harness/core";
import type {
  LocalStateService,
  SecretVaultService,
} from "@harness/storage";
import type { RunnerService } from "@harness/runners";
import type { ShadowWorkspaceService } from "@harness/runners";
import type { QualityEvaluator, RepairLoopService } from "@harness/quality";
import {
  loadSkills,
  type CapabilityRegistry,
  type CapabilityService,
  type SkillSourceConfig,
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
import { eventBus } from "../event-bus";

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
}

/**
 * Single registration entry point.
 */
export const registerAllIpc = (ctx: IpcContext): void => {
  registerAppIpc();
  registerStateIpc(ctx.state);
  registerConversationIpc(
    ctx.conversation,
    ctx.state,
    eventBus,
    ctx.instinctService,
  );
  registerRunnerIpc(ctx.runner, ctx.state, ctx.artifactStore, eventBus);
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
    mcp: ctx.state.mcpServers,
    probe: ctx.mcpProbe,
  });
  registerSkillSourceIpc({
    state: ctx.state,
    skillSources: ctx.state.skillSources,
    pathPolicy: ctx.skillRootPolicy,
    capabilityRegistry: {
      refresh: async (source) => {
        // Rebuild from persisted rows so custom sources added in Settings
        // participate in the manual refresh without requiring a restart.
        const rows = await ctx.state.skillSources.list();
        const enabled = rows.filter((row) => row.enabled);
        const configs = enabled.map(skillSourceConfigFromRow);
        const scanned = source.enabled
          ? await loadSkills({
              rootDir: source.rootDir,
              trusted: source.trusted,
            })
          : [];
        const caps = await ctx.capabilityRegistry.refresh(configs);
        for (const disabled of rows.filter((row) => !row.enabled)) {
          await ctx.state.pruneCapabilities(
            skillSourceConfigFromRow(disabled).source,
            [],
          );
        }
        const sourceKey = skillSourceConfigFromRow(source).source;
        return {
          sourceId: source.id,
          scannedCount: scanned.length,
          updatedCount: caps.filter((cap) => cap.source === sourceKey).length,
          skillCount: caps.length,
        };
      },
    },
  });
  registerSecretIpc({ vault: ctx.secretVault });
};

const skillSourceConfigFromRow = (source: SkillSource): SkillSourceConfig => ({
  source:
    source.origin === "project"
      ? "skillify:project"
      : source.origin === "user"
        ? "skillify:user"
        : `skillify:${source.id}`,
  rootDir: source.rootDir,
  trusted: source.trusted,
});
