import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import {
  ConversationService,
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
  TaskRunCompletionService,
  type HarnessSettings,
} from "@harness/core";
import {
  FilesystemArtifactStore,
  LocalStateService,
  SecretVaultService,
  openDb,
  type HarnessDb,
} from "@harness/storage";
import type {
  AgentProfile,
  AgentProvider,
  McpServerConfig,
  McpServerHealth,
  Observation,
  QualityGateResult,
} from "@harness/core";
import type { SkillRootPolicy } from "./ipc/skill-source-ipc";
import { RunnerService, ShadowWorkspaceService, inspectDeleteFile } from "@harness/runners";
import { QualityEvaluator, RepairLoopService } from "@harness/quality";
import {
  CapabilityRegistry,
  CapabilityService,
  type SkillSourceConfig,
} from "@harness/skillify-adapter";
import {
  deriveProjectKey,
  InstinctService,
  LearnerAdvisor,
  TopologyAdvisor,
  TraceRecorder,
  FailureLearningService,
} from "@harness/learner";
import {
  HarnessPackageService,
  OrchestrationService,
} from "@harness/orchestration";
import {
  AgentInvocationQueue,
  AgentPlanningService,
  FakeModelCliAdapter,
  RepoIndexService,
  buildCodexMcpConfigOverrides,
  checkProviders as probeAgentProviders,
  formatContextPackObservationPayload,
  packRepoContext,
} from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAllIpc } from "./ipc";
import { ipcWorkScope } from "./ipc/ipc-lifecycle";
import { installApplicationShutdown } from "./services/application-shutdown";
import { verifyReportDelivery } from "./services/report-delivery-verifier";
import {
  eventBus,
  setDiagnosticsEmitter,
  setTaskRunChangedObserver,
} from "./event-bus";
import { createA2AWorkerRouter } from "./a2a-worker-composition";
import { createMcpProbe, resolveMcpCommand } from "./mcp-probe";
import { SystemDiagnosticsService } from "./services/system-diagnostics-service";
import {
  startDiagnosticsHeartbeat,
  type DiagnosticsHeartbeatController,
} from "./services/diagnostics-heartbeat";
import { startPrimaryInstance } from "./single-instance";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.HARNESS_E2E_USER_DATA) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}

let mainDb: HarnessDb | null = null;
let diagnosticsHeartbeat: DiagnosticsHeartbeatController | null = null;
let runtimeServices: ReturnType<typeof initServices> | null = null;
let backgroundWork: ReturnType<typeof registerAllIpc> | null = null;
let startupWork: Promise<void> | null = null;
let shutdownRequested = false;

const traceStartup = (step: string): void => {
  if (process.env.HARNESS_STARTUP_TRACE === "1") {
    console.log(`[harness:start] ${step}`);
  }
};

const latestPinnedContextPackObservation = async (
  state: LocalStateService,
  taskRunId: string,
): Promise<Observation | null> => {
  const observations = await state.listObservations({ taskRunId, limit: 50 });
  return (
    observations.find(
      (observation) =>
        observation.source === "agent" &&
        observation.eventType === "context_pack_created" &&
        observation.signal === "context_pack" &&
        pinnedObservationIdsFromContextPackPayload(observation.payload).length >
          0,
    ) ?? null
  );
};

const pinnedObservationIdsFromContextPackPayload = (
  payload: Record<string, unknown>,
): string[] => {
  const promptInclusion = payload.promptInclusion;
  if (!isRecord(promptInclusion)) return [];
  return normalizeObservationIds(promptInclusion.pinnedObservationIds);
};

const contextPackArtifactIdFromPayload = (
  payload: Record<string, unknown>,
): string | undefined => {
  const contextPackArtifactId = payload.contextPackArtifactId;
  return typeof contextPackArtifactId === "string" &&
    contextPackArtifactId.length > 0
    ? contextPackArtifactId
    : undefined;
};

const normalizeObservationIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === 5) break;
  }
  return ids;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const initServices = (): {
  state: LocalStateService;
  conversation: ConversationService;
  runner: RunnerService;
  shadowWorkspace: ShadowWorkspaceService;
  artifactStore: FilesystemArtifactStore;
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
  onSettingsUpdate: (s: HarnessSettings) => void;
  secretVault: SecretVaultService;
  skillRootPolicy: SkillRootPolicy;
  mcpProbe: (server: McpServerConfig) => Promise<McpServerHealth>;
  diagnosticsService: SystemDiagnosticsService;
  shutdownWorkers: () => Promise<void>;
} => {
  const userData = app.getPath("userData");
  const dbPath = join(userData, "app.db");
  mainDb = openDb({ filePath: dbPath });
  // Only the application startup (not every database connection) recovers lost claims.
  // Never replay a command after a crash: the external effect may already exist.
  mainDb.prepare(`UPDATE approvals SET execution_state='uncertain', execution_finished_at=?
    WHERE execution_state='running'`).run(new Date().toISOString());

  const state = new LocalStateService(mainDb);
  state.workspaceMutations.recoverAbandoned();
  const artifactStore = new FilesystemArtifactStore({
    rootDir: join(userData, "artifacts"),
  });
  const conversation = new ConversationService({
    inspectDeleteFile,
    state,
    pathExists: async (path: string) => {
      try {
        const s = await stat(path);
        return s.isDirectory();
      } catch {
        return false;
      }
    },
  });
  const runner = new RunnerService({
    trashItem: path => shell.trashItem(path),
    state,
    artifactStore,
    recordPinnedContextOutcome: async ({
      taskRun,
      approval,
      status,
      summary,
      errorCode,
      errorArtifactId,
    }) => {
      const contextPack = await latestPinnedContextPackObservation(
        state,
        taskRun.id,
      );
      if (!contextPack) return;
      const pinnedObservationIds = pinnedObservationIdsFromContextPackPayload(
        contextPack.payload,
      );
      if (pinnedObservationIds.length === 0) return;
      const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
      await state.createObservation({
        taskRunId: taskRun.id,
        threadId: taskRun.threadId,
        projectKey,
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: status,
        summary,
        payload: {
          outcomeSource: "runner.executeApproved",
          outcomeStatus: status,
          qualityStatus: status,
          runnerErrorCode: errorCode,
          approvalId: approval.id,
          approvalActionType: approval.actionType,
          errorArtifactId,
          contextPackObservationId: contextPack.id,
          contextPackArtifactId:
            contextPackArtifactIdFromPayload(contextPack.payload) ?? null,
          pinnedObservationIds,
        },
      });
    },
  });
  const shadowWorkspace = new ShadowWorkspaceService({
    state,
    artifactStore,
    shadowRootDir: join(userData, "shadow-workspaces"),
  });
  const repoIndexService = new RepoIndexService({
    store: state.repoIndex,
  });
  const qualityEvaluator = new QualityEvaluator({ state,
    verifyReportDelivery: async (task, diffs) => {
      const approvals = await state.listApprovalsByTaskRun(task.id);
      const writes = approvals.filter(a => a.actionType === "file_write");
      // Every observed change must be covered by a completed report write.
      if (diffs.length !== writes.length) return false;
      return verifyReportDelivery(task, approvals);
    },
  });
  // Trace recorder is constructed first so the completion service can
  // stamp a LearningTrace as part of every markDone (Phase 6 acceptance).
  const traceRecorder = new TraceRecorder({ state });
  const failureLearning = new FailureLearningService({state,artifactStore});
  const instinctService = new InstinctService({ state,recordVerifiedRepairs:input=>failureLearning.recordRecovery(input) });
  const refreshInstinctCandidates = async (observation: Observation): Promise<void> => {
    await instinctService.refreshCandidates(
      observation.projectKey ? { projectKey: observation.projectKey } : {},
    );
  };
  const learnerAdvisor = new LearnerAdvisor({
    state,
    decisionLogDir: join(userData, "learner-decisions"),
    onObservationRecorded: refreshInstinctCandidates,
  });
  const qualityCompletion = new TaskRunCompletionService({
    state,
    onTaskRunDone: async (taskRunId) => {
      const gate = await state.getLatestQualityGateResult(taskRunId);
      const costSummary = await learnerAdvisor.summarizeTaskRunCost({
        taskRunId,
      });
      const completedLatencies = costSummary.invocations
        .filter(
          (invocation) =>
            invocation.success !== undefined && invocation.latencyMs > 0,
        )
        .map((invocation) => invocation.latencyMs);
      const latencyMs =
        completedLatencies.length > 0
          ? Math.round(
              completedLatencies.reduce((sum, value) => sum + value, 0) /
                completedLatencies.length,
            )
          : undefined;
      await traceRecorder.recordOutcome({
        taskRunId,
        success: true,
        qualityGate: gate ?? null,
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(costSummary.invocationCount > 0
          ? { costEstimate: costSummary.totalCostUsd }
          : {}),
      });
    },
    onQualityGateFailed: async (gate: QualityGateResult) => {
      const costSummary = await learnerAdvisor.summarizeTaskRunCost({
        taskRunId: gate.taskRunId,
      });
      const completedLatencies = costSummary.invocations
        .filter(
          (invocation) =>
            invocation.success !== undefined && invocation.latencyMs > 0,
        )
        .map((invocation) => invocation.latencyMs);
      const latencyMs =
        completedLatencies.length > 0
          ? Math.round(
              completedLatencies.reduce((sum, value) => sum + value, 0) /
                completedLatencies.length,
            )
          : undefined;
      await traceRecorder.recordOutcome({
        taskRunId: gate.taskRunId,
        success: false,
        qualityGate: gate,
        failureReason:
          gate.knownRisks.length > 0
            ? gate.knownRisks.slice(0, 3).join("; ")
            : "quality gate failed",
        ...(latencyMs !== undefined ? { latencyMs } : {}),
        ...(costSummary.invocationCount > 0
          ? { costEstimate: costSummary.totalCostUsd }
          : {}),
      });
    },
  });
  const capabilityRegistry = new CapabilityRegistry({ state });
  const capabilityService = new CapabilityService({
    state,
    registry: capabilityRegistry,
  });
  // Phase 5 trusted skill roots:
  //   1) HarnessAgentOS/skills (project, immutable in app context)
  //   2) userData/skills (user-managed, mutable)
  // Both are marked trusted; untrusted sources can be added later via UI.
  const skillSources: SkillSourceConfig[] = [
    {
      source: "skillify:project",
      rootDir: join(dirname(fileURLToPath(import.meta.url)), "../../skills"),
      trusted: true,
    },
    {
      source: "skillify:user",
      rootDir: join(userData, "skills"),
      trusted: true,
    },
  ];
  const topologyAdvisor = new TopologyAdvisor({
    state,
    metadataForCapability: (id) => capabilityRegistry.getMetadata(id),
    onObservationRecorded: refreshInstinctCandidates,
  });
  // Phase 7 feature flag — defaults off per phase-07 spec.
  // Mutable ref is seeded from persisted settings in app.whenReady()
  // before IPC is registered; env var acts as OR override for devs.
  // The OrchestrationService is constructed later (after agentPlanning)
  // so the worker-runner can call back into the real CLI.
  let orchEnabledBySettings = false;
  const onSettingsUpdate = (s: HarnessSettings): void => {
    orchEnabledBySettings = s.orchestration?.enabled ?? false;
  };

  // Phase 8 — agent CLI integration. The queue is shared between the
  // planning service (concurrency control) and the provider probe
  // (so RuntimeStatusBar can show live queue depth).
  const agentQueue = new AgentInvocationQueue();
  const useE2eFakeAgent =
    process.env.HARNESS_E2E_USER_DATA !== undefined &&
    process.env.HARNESS_E2E_FAKE_AGENT === "1";
  let cachedProviders: AgentProviderStatusMap | null = useE2eFakeAgent
    ? {
        codex: {
          available: true,
          version: "e2e-fake",
          command: "in-process",
          queueDepth: 0,
        },
      }
    : null;
  const probeProviders = async (): Promise<AgentProviderStatusMap> => {
    if (useE2eFakeAgent) {
      const result: AgentProviderStatusMap = {
        codex: {
          available: true,
          version: "e2e-fake",
          command: "in-process",
          queueDepth: agentQueue.getDepth("codex"),
        },
      };
      cachedProviders = result;
      return result;
    }
    const result = await probeAgentProviders({
      getQueueDepth: (p) => agentQueue.getDepth(p),
    });
    cachedProviders = result;
    return result;
  };
  // Phase 3 — secret vault wired to Electron's safeStorage. On Linux
  // environments where the backend is unavailable, write() throws
  // SecretVaultUnavailableError; the renderer surfaces a banner.
  const secretVault = new SecretVaultService(mainDb, safeStorage);

  const prepareMcpInvocation = async ({
    profileId,
    provider: _provider,
  }: {
    profileId: string | null;
    provider: AgentProvider;
  }): Promise<{
    codexConfigOverrides: readonly string[];
    cleanup: () => Promise<void>;
  }> => {
    const empty = {
      codexConfigOverrides: [] as readonly string[],
      cleanup: async () => {},
    };
    const all = await state.mcpServers.list();
    let active = all.filter((s) => s.enabled && s.scope === "global");
    let profileForPolicy: AgentProfile | null = null;
    if (profileId !== null) {
      const profile = await state.agentProfiles.get(profileId).catch(() => null);
      if (profile) {
        profileForPolicy = profile;
        const perAgent = all.filter(
          (s) =>
            s.enabled &&
            s.scope === "per-agent" &&
            profile.mcpServerIds.includes(s.id),
        );
        active = [...active, ...perAgent];
      }
    }
    if (active.length === 0) {
      return empty;
    }
    const activeForConfig = await Promise.all(
      active.map(async (server) =>
        server.transport === "stdio" && server.command
          ? { ...server, command: await resolveMcpCommand(server.command) }
          : server,
      ),
    );
    const codexConfigOverrides = buildCodexMcpConfigOverrides(
      activeForConfig,
      profileForPolicy?.permissions,
    );
    if (codexConfigOverrides.length === 0) {
      return empty;
    }
    return {
      codexConfigOverrides,
      cleanup: async () => {},
    };
  };

  const agentPlanning = new AgentPlanningService({
    state,
    queue: agentQueue,
    ...(useE2eFakeAgent
      ? {
          adapter: new FakeModelCliAdapter({
            scenario: process.env.HARNESS_E2E_SCENARIO === "ok-html-report" ? "ok-html-report" : "ok-answer-only",
            ...(process.env.HARNESS_E2E_SCENARIO === "html-harness" ? {
              scenarios: ["ok-answer-only", "ok-html-report", "ok-answer-only"] as const,
            } : {}),
            ...(process.env.HARNESS_E2E_SCENARIO === "code-harness" ? {
              scenarios: ["ok-code-patch", "ok-code-test", "ok-answer-only"] as const,
            } : {}),
            ...(process.env.HARNESS_E2E_SCENARIO === "failed-harness" ? {
              scenarios: ["ok-answer-only", "spawn-failed"] as const,
            } : {}),
            chunkDelayMs: process.env.HARNESS_E2E_SCENARIO?.endsWith("-harness") ? 10 : 500,
          }),
        }
      : {}),
    getProviderStatus: () => cachedProviders,
    emitStreamEvent: (event) => eventBus.agentStreamEvent(event),
    prepareMcpInvocation,
    getApprovedCapabilityContexts: ({ taskRunId, profileId }) =>
      capabilityService.approvedPromptContexts({ taskRunId, profileId }),
    getApprovedLearnerModel: ({ taskRunId }) =>
      learnerAdvisor.approvedModelContext({ taskRunId }),
    getActiveInstincts: async ({ taskRun }) => {
      return instinctService.forTask({taskRun});
    },
    recordContextPackObservation: async ({
      taskRun,
      contextPack,
      contextPackArtifactId,
    }) => {
      const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
      return state.createObservation({
        taskRunId: taskRun.id,
        threadId: taskRun.threadId,
        projectKey,
        source: "agent",
        eventType: "context_pack_created",
        signal: "context_pack",
        summary: `agent context pack prepared (${contextPack.sources.length} sources)`,
        payload: formatContextPackObservationPayload(
          contextPack,
          contextPackArtifactId,
        ),
      });
    },
    recordPinnedContextOutcome: async ({
      taskRun,
      status,
      summary,
      pinnedObservationIds,
      contextPackObservationId,
      contextPackArtifactId,
      errorCode,
    }) => {
      const normalizedPinnedObservationIds = [
        ...new Set(
          pinnedObservationIds
            .map((id) => id.trim())
            .filter((id) => id.length > 0),
        ),
      ].slice(0, 5);
      if (normalizedPinnedObservationIds.length === 0) return;
      const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
      await state.createObservation({
        taskRunId: taskRun.id,
        threadId: taskRun.threadId,
        projectKey,
        source: "learner",
        eventType: "pinned_context_outcome",
        signal: status,
        summary,
        payload: {
          outcomeSource: "agent.generatePlan",
          outcomeStatus: status,
          qualityStatus: status,
          agentErrorCode: errorCode ?? null,
          contextPackObservationId: contextPackObservationId ?? null,
          contextPackArtifactId: contextPackArtifactId ?? null,
          pinnedObservationIds: normalizedPinnedObservationIds,
        },
      });
    },
    getRepoContext: async ({ taskRun, prompt }) => {
      const files = await repoIndexService.refresh({
        projectKey: taskRun.targetDir,
        targetDir: taskRun.targetDir,
      });
      return packRepoContext({ prompt, files });
    },
    recordLearnerSelection: ({ taskRunId, selectedModel, selectedCapabilities }) =>
      traceRecorder.recordSelection({
        taskRunId,
        ...(selectedModel !== undefined ? { selectedModel } : {}),
        ...(selectedCapabilities !== undefined ? { selectedCapabilities } : {}),
      }),
    // Long-running agent work is valid, but a child process must never
    // hang forever. Keep a generous hard timeout and a separate idle
    // timeout for "no output" stalls.
    defaults: {
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
    },
  });

  const repairLoop = new RepairLoopService({
    state,
    completion: qualityCompletion,
    agentPlanning,
    getRegressionRepairContext:gate=>runner.getRegressionRepairContext(gate),
  });

  // Phase D — pipeline workers use local CLI by default, or route through
  // the trusted remote A2A endpoint selected on the pipeline step.
  const orchestrationWorkerInvoker = createA2AWorkerRouter({
    state,
    localInvoker: {
      invokeForWorker: (input) => agentPlanning.invokeForWorker(input),
    },
    emitStreamEvent: (event) => eventBus.agentStreamEvent(event),
  });

  // Phase 2 — OrchestrationService is wired AFTER agentPlanning so the
  // worker-runner can invoke the real CLI/A2A route for pipeline-driven steps.
  const orchestrationService = new OrchestrationService({
    state,
    enabled: () =>
      process.env.HARNESS_ORCHESTRATION_ENABLED === "1" || orchEnabledBySettings,
    agentPlanning: orchestrationWorkerInvoker,
    onTaskRunChanged: (taskRunId) => eventBus.taskRunChanged(taskRunId),
  });

  // Phase 3 — path-policy registry hook. The skillSource IPC pushes
  // user-registered roots through this so invocations see them without
  // a restart. Phase 4 will replace the in-memory mutable list with a
  // real call into the path-policy module.
  const dynamicSourceDirs = new Set<string>();
  const skillRootPolicy: SkillRootPolicy = {
    registerSourceDir: (dir) => {
      dynamicSourceDirs.add(dir);
    },
    unregisterSourceDir: (dir) => {
      dynamicSourceDirs.delete(dir);
    },
  };

  const mcpProbe = createMcpProbe();
  const diagnosticsService = new SystemDiagnosticsService({
    database: state,
    agentPlanning,
    runner,
    capabilities: capabilityRegistry,
    probeProviders,
  });

  return {
    state,
    conversation,
    runner,
    shadowWorkspace,
    artifactStore,
    qualityEvaluator,
    qualityCompletion,
    repairLoop,
    capabilityService,
    capabilityRegistry,
    skillSources,
    learnerAdvisor,
    topologyAdvisor,
    traceRecorder,
    instinctService,
    orchestrationService,
    agentPlanning,
    probeAgentProviders: probeProviders,
    onSettingsUpdate,
    secretVault,
    skillRootPolicy,
    mcpProbe,
    diagnosticsService,
    shutdownWorkers: async () => {
      const outcomes = await Promise.allSettled([
        orchestrationWorkerInvoker.shutdown(), agentPlanning.shutdown(), runner.shutdown(), orchestrationService.shutdown(),
      ]);
      const failures = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason);
      if (failures.length) throw new AggregateError(failures, "Worker shutdown could not be confirmed");
    },
  };
};

const createMainWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#090e14",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#090e14",
      symbolColor: "#edf3f8",
      height: 52,
    },
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/preload.cjs"),
    },
  });

  win.removeMenu();

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (e, url) => {
    const allowed = url.startsWith("file://") || url.startsWith("devtools://");
    if (!allowed) e.preventDefault();
  });

  void win.loadFile(join(__dirname, "../renderer/index.html"));

  return win;
};

const startApplication = async (): Promise<void> => {
  traceStartup("initServices:start");
  const services = initServices();
  runtimeServices = services;
  traceStartup("initServices:done");
  // Seed orchestration flag from persisted settings before IPC goes live.
  try {
    traceStartup("settings:start");
    const s = await services.state.getSettings();
    services.onSettingsUpdate(s);
    traceStartup("settings:done");
  } catch {
    // non-fatal; mutable ref stays false
  }
  // Phase 5a — seed the project/user skill-source sentinels so the new
  // Settings → Skills tab shows them on first launch. Idempotent: pre-
  // existing rows (including user-renamed sentinels) are left untouched.
  try {
    traceStartup("skillSources:start");
    const project = services.skillSources.find(
      (s) => s.source === "skillify:project",
    );
    const user = services.skillSources.find(
      (s) => s.source === "skillify:user",
    );
    if (project && user) {
      await services.state.skillSources.ensureSeed({
        projectRootDir: project.rootDir,
        userRootDir: user.rootDir,
      });
    }
    traceStartup("skillSources:done");
  } catch {
    // non-fatal — UI just won't pre-populate the sentinels.
  }
  // Seed canonical and framework-derived agent profiles on first launch.
  try {
    traceStartup("agentProfiles:start");
    await services.state.agentProfiles.ensureSeed();
    traceStartup("agentProfiles:done");
  } catch {
    // non-fatal — UI still works with an empty profile list.
  }
  // Seed safe, disabled starter endpoints and built-in harness workflows.
  // Existing rows are preserved and fixed ids keep this idempotent.
  try {
    traceStartup("remoteAgents:start");
    await services.state.a2aRemoteAgents.ensureSeed();
    traceStartup("remoteAgents:done");
  } catch {
    // non-fatal — users can still register remote endpoints manually.
  }
  try {
    traceStartup("harnessPackages:start");
    await services.state.harnessPackages.ensureSeed();
    traceStartup("harnessPackages:done");
  } catch {
    // non-fatal — users can still import or create harness packages manually.
  }
  // Connect built-in starter workflows to exact matching profile roles.
  // Existing user binding sets always win and imported packages are untouched.
  try {
    traceStartup("harnessBindingSets:start");
    await new HarnessPackageService({
      state: services.state,
    }).ensureStarterBindingSets();
    traceStartup("harnessBindingSets:done");
  } catch {
    // non-fatal — users can still create binding sets manually.
  }
  // Seed reusable role-aware pipeline templates after profiles exist.
  try {
    traceStartup("agentPipelines:start");
    await services.state.agentPipelines.ensureSeed();
    traceStartup("agentPipelines:done");
  } catch {
    // non-fatal — users can still create pipelines manually.
  }
  // Best-effort initial capability scan; missing skill directories are
  // non-fatal so first-run still succeeds.
  try {
    traceStartup("capabilities:start");
    await services.capabilityRegistry.refreshPersistedSources();
    traceStartup("capabilities:done");
  } catch {
    // capability diagnostics and capability.refresh IPC surface the failure.
  }
  if (shutdownRequested) return;
  traceStartup("ipc:start");
  backgroundWork = registerAllIpc(services);
  diagnosticsHeartbeat = startDiagnosticsHeartbeat({
    collect: () => services.diagnosticsService.collect(),
    emit: (diagnostics) => eventBus.diagnosticsHeartbeat(diagnostics),
  });
  setDiagnosticsEmitter(() => {
    void diagnosticsHeartbeat?.emitNow();
  });
  traceStartup("window:start");
  createMainWindow();
  traceStartup("window:done");

  app.on("activate", () => {
    if (!shutdownRequested && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
};

const primaryInstance = startPrimaryInstance({
  app,
  getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  start: () => {
    if (shutdownRequested) return;
    startupWork = startApplication();
    return startupWork;
  },
  onError: (error) => {
    console.error("[harness:start] failed", error);
    app.quit();
  },
});

if (primaryInstance) {
  installApplicationShutdown({
    app,
    drain: async () => {
      shutdownRequested = true;
      ipcWorkScope.seal();
      const heartbeatStopped = diagnosticsHeartbeat?.stop();
      diagnosticsHeartbeat = null;
      setDiagnosticsEmitter(null);
      setTaskRunChangedObserver(null);
      // Pause first to prevent dispatch. After settlement, standalone work
      // must retain the existing blocked/review retry path; pipelines resume.
      const runnerTaskIds = runtimeServices?.runner.getActiveTaskRunIds() ?? [];
      const standaloneTaskIds = new Set(runnerTaskIds);
      const interruptedTaskIds = new Set<string>();
      const pauseActiveTasks = () => {
        if (!mainDb?.open) return;
        // Current invocation ownership wins over historical pipeline consent.
        const planners = mainDb.prepare(
          `SELECT DISTINCT i.task_run_id AS id FROM agent_invocations i
           JOIN steps s ON s.id=i.step_id WHERE i.status IN ('queued','running') AND s.kind='plan'`,
        ).all() as { id: string }[];
        for (const row of planners) standaloneTaskIds.add(row.id);
        const rows = mainDb.prepare(
          `SELECT id FROM task_runs WHERE status IN ('drafting','running') OR
           (status NOT IN ('paused','done','cancelled') AND
            (id IN (SELECT value FROM json_each(?)) OR
             id IN (SELECT task_run_id FROM agent_invocations WHERE status IN ('queued','running'))))`,
        ).all(JSON.stringify(runnerTaskIds)) as { id: string }[];
        for (const row of rows) interruptedTaskIds.add(row.id);
        mainDb.prepare(
          `UPDATE task_runs SET status='paused', updated_at=?
           WHERE status IN ('drafting','running') OR
             (status NOT IN ('paused','done','cancelled') AND
              (id IN (SELECT value FROM json_each(?)) OR
               id IN (SELECT task_run_id FROM agent_invocations WHERE status IN ('queued','running'))))`,
        ).run(new Date().toISOString(), JSON.stringify(runnerTaskIds));
      };
      const failures: unknown[] = [];
      try { pauseActiveTasks(); } catch (error) { failures.push(error); }
      const outcomes = await Promise.allSettled([
        backgroundWork?.shutdown(), runtimeServices?.shutdownWorkers(), ipcWorkScope.drain(), startupWork?.catch(() => {}), heartbeatStopped,
      ]);
      failures.push(...outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason));
      try {
        pauseActiveTasks();
        if (mainDb?.open) mainDb.prepare(
          `UPDATE task_runs SET status='blocked', updated_at=?
           WHERE status='paused' AND id IN (SELECT value FROM json_each(?)) AND
            (id IN (SELECT value FROM json_each(?)) OR NOT EXISTS
             (SELECT 1 FROM approvals WHERE task_run_id=task_runs.id AND action_type='orchestration_plan'))`,
        ).run(new Date().toISOString(), JSON.stringify([...interruptedTaskIds]), JSON.stringify([...standaloneTaskIds]));
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Application work did not shut down cleanly");
    },
    close: () => {
      if (mainDb?.open) mainDb.close();
      mainDb = null;
    },
    onError: error => {
      console.error("[harness:shutdown] cleanup incomplete", error);
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      dialog.showErrorBox("앱 종료 정리를 완료하지 못했습니다", "진행 중인 작업의 정리가 확인되지 않아 저장소를 열어 두었습니다. 정리가 끝난 뒤 창을 닫아 다시 시도하세요. 강제 종료는 미확정 실행을 남길 수 있습니다.");
    },
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
}
