import type {
  ArtifactStore,
  ConversationService,
  TaskRunCompletionService,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
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
  );
  registerLearnerIpc(ctx.learnerAdvisor, ctx.traceRecorder);
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
  registerSettingsIpc(ctx.state);
};
