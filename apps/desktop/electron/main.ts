import { app, BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import {
  ConversationService,
  TaskRunCompletionService,
} from "@harness/core";
import {
  FilesystemArtifactStore,
  LocalStateService,
  openDb,
  type HarnessDb,
} from "@harness/storage";
import { RunnerService } from "@harness/runners";
import { QualityEvaluator } from "@harness/quality";
import {
  CapabilityRegistry,
  CapabilityService,
  type SkillSourceConfig,
} from "@harness/skillify-adapter";
import { LearnerAdvisor, TraceRecorder } from "@harness/learner";
import { OrchestrationService } from "@harness/orchestration";
import {
  AgentInvocationQueue,
  AgentPlanningService,
  checkProviders as probeAgentProviders,
} from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAllIpc } from "./ipc";
import { eventBus } from "./event-bus";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainDb: HarnessDb | null = null;

const initServices = (): {
  state: LocalStateService;
  conversation: ConversationService;
  runner: RunnerService;
  artifactStore: FilesystemArtifactStore;
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
  const runner = new RunnerService({ state, artifactStore });
  const qualityEvaluator = new QualityEvaluator({ state });
  // Trace recorder is constructed first so the completion service can
  // stamp a LearningTrace as part of every markDone (Phase 6 acceptance).
  const traceRecorder = new TraceRecorder({ state });
  const qualityCompletion = new TaskRunCompletionService({
    state,
    onTaskRunDone: async (taskRunId) => {
      const gate = await state.getLatestQualityGateResult(taskRunId);
      await traceRecorder.recordOutcome({
        taskRunId,
        success: true,
        qualityGate: gate ?? null,
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
  const learnerAdvisor = new LearnerAdvisor({
    state,
    decisionLogDir: join(userData, "learner-decisions"),
  });
  // Phase 7 feature flag — defaults off per phase-07 spec.
  const orchestrationEnabled =
    process.env.HARNESS_ORCHESTRATION_ENABLED === "1";
  const orchestrationService = new OrchestrationService({
    state,
    enabled: orchestrationEnabled,
  });

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
  const agentPlanning = new AgentPlanningService({
    state,
    queue: agentQueue,
    getProviderStatus: () => cachedProviders,
    emitStreamEvent: (event) => eventBus.agentStreamEvent(event),
    // Claude CLI in `--print` mode is non-streaming: stdout stays empty
    // until the full response is generated and then flushes at once.
    // The default 30s stall timer therefore mis-fires on any non-trivial
    // prompt. Use a single overall timeout (5 min) and an equally long
    // stall budget so the stall check effectively never fires on its own.
    defaults: { timeoutMs: 5 * 60_000, stallTimeoutMs: 5 * 60_000 },
  });

  return {
    state,
    conversation,
    runner,
    artifactStore,
    qualityEvaluator,
    qualityCompletion,
    capabilityService,
    capabilityRegistry,
    skillSources,
    learnerAdvisor,
    traceRecorder,
    orchestrationService,
    agentPlanning,
    probeAgentProviders: probeProviders,
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
  const services = initServices();
  // Best-effort initial capability scan; missing skill directories are
  // non-fatal so first-run still succeeds.
  try {
    await services.capabilityRegistry.refresh(services.skillSources);
  } catch {
    // capability.refresh IPC will surface a clearer error to the UI.
  }
  registerAllIpc(services);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (mainDb && mainDb.open) mainDb.close();
  mainDb = null;
});

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
});
