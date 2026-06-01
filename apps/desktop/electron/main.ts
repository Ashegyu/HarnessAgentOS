import { app, BrowserWindow, safeStorage, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { RunnerService, ShadowWorkspaceService } from "@harness/runners";
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
} from "@harness/learner";
import { OrchestrationService } from "@harness/orchestration";
import {
  AgentInvocationQueue,
  AgentPlanningService,
  RepoIndexService,
  buildCodexMcpConfigOverrides,
  buildClaudeMcpConfig,
  checkProviders as probeAgentProviders,
  formatContextPackObservationPayload,
  packRepoContext,
} from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAllIpc } from "./ipc";
import { eventBus, setDiagnosticsEmitter } from "./event-bus";
import { createA2AWorkerRouter } from "./a2a-worker-composition";
import { createMcpProbe, resolveMcpCommand } from "./mcp-probe";
import { SystemDiagnosticsService } from "./services/system-diagnostics-service";
import {
  startDiagnosticsHeartbeat,
  type DiagnosticsHeartbeatController,
} from "./services/diagnostics-heartbeat";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.HARNESS_E2E_USER_DATA) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}

let mainDb: HarnessDb | null = null;
let diagnosticsHeartbeat: DiagnosticsHeartbeatController | null = null;

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
} => {
  const userData = app.getPath("userData");
  const dbPath = join(userData, "app.db");
  mainDb = openDb({ filePath: dbPath });

  const state = new LocalStateService(mainDb);
  const artifactStore = new FilesystemArtifactStore({
    rootDir: join(userData, "artifacts"),
  });
  const conversation = new ConversationService({
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
  const qualityEvaluator = new QualityEvaluator({ state });
  // Trace recorder is constructed first so the completion service can
  // stamp a LearningTrace as part of every markDone (Phase 6 acceptance).
  const traceRecorder = new TraceRecorder({ state });
  const learnerAdvisor = new LearnerAdvisor({
    state,
    decisionLogDir: join(userData, "learner-decisions"),
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
  });
  const instinctService = new InstinctService({ state });
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
  let cachedProviders: AgentProviderStatusMap | null = null;
  const probeProviders = async (): Promise<AgentProviderStatusMap> => {
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

  // Phase 4b — temp dir for per-invocation MCP config files. We never
  // reuse a file across invocations so a process crash can't leak old
  // secret material; cleanup removes the file when generatePlan returns.
  const mcpTmpDir = join(userData, "mcp-tmp");

  const prepareMcpInvocation = async ({
    profileId,
    provider,
  }: {
    profileId: string | null;
    provider: AgentProvider;
  }): Promise<{
    mcpConfigPath: string | null;
    codexConfigOverrides?: readonly string[];
    cleanup: () => Promise<void>;
  }> => {
    const empty = {
      mcpConfigPath: null,
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
    if (provider === "codex") {
      const codexConfigOverrides = buildCodexMcpConfigOverrides(
        activeForConfig,
        profileForPolicy?.permissions,
      );
      if (codexConfigOverrides.length === 0) {
        return empty;
      }
      return {
        mcpConfigPath: null,
        codexConfigOverrides,
        cleanup: async () => {},
      };
    }
    const config = await buildClaudeMcpConfig(
      activeForConfig,
      async (k) => secretVault.read(k),
      profileForPolicy?.permissions,
    );
    if (Object.keys(config.mcpServers).length === 0) {
      return empty;
    }
    await mkdir(mcpTmpDir, { recursive: true });
    const file = join(mcpTmpDir, `mcp-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(config), {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      mcpConfigPath: file,
      cleanup: async () => {
        try {
          await unlink(file);
        } catch {
          // file already gone or never written — fine.
        }
      },
    };
  };

  const agentPlanning = new AgentPlanningService({
    state,
    queue: agentQueue,
    getProviderStatus: () => cachedProviders,
    emitStreamEvent: (event) => eventBus.agentStreamEvent(event),
    prepareMcpInvocation,
    getApprovedCapabilityContexts: ({ taskRunId, profileId }) =>
      capabilityService.approvedPromptContexts({ taskRunId, profileId }),
    getApprovedLearnerModel: ({ taskRunId }) =>
      learnerAdvisor.approvedModelContext({ taskRunId }),
    getActiveInstincts: async ({ taskRun }) => {
      const projectKey = await deriveProjectKey({ targetDir: taskRun.targetDir });
      return instinctService.list({ projectKey });
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
  };
};

const createMainWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0e1116",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/preload.cjs"),
    },
  });

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

app.whenReady().then(async () => {
  traceStartup("initServices:start");
  const services = initServices();
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
  traceStartup("ipc:start");
  registerAllIpc(services);
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
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error("[harness:start] failed", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  diagnosticsHeartbeat?.stop();
  diagnosticsHeartbeat = null;
  setDiagnosticsEmitter(null);
  if (mainDb && mainDb.open) mainDb.close();
  mainDb = null;
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
});
