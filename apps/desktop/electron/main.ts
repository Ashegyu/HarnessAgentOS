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
  AgentProvider,
  McpServerConfig,
  McpServerHealth,
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
  buildClaudeMcpConfig,
  checkProviders as probeAgentProviders,
  packRepoContext,
} from "@harness/agent";
import type { AgentProviderStatusMap } from "@harness/core";
import { registerAllIpc } from "./ipc";
import { eventBus } from "./event-bus";
import { createA2AWorkerRouter } from "./a2a-worker-composition";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainDb: HarnessDb | null = null;

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
    cleanup: () => Promise<void>;
  }> => {
    // Codex CLI MCP arg format is not yet verified (V2 pending) — skip the
    // file write for codex so we don't pass an unrecognized flag.
    if (provider !== "claude") {
      return { mcpConfigPath: null, cleanup: async () => {} };
    }
    const all = await state.mcpServers.list();
    let active = all.filter((s) => s.enabled && s.scope === "global");
    if (profileId !== null) {
      const profile = await state.agentProfiles.get(profileId).catch(() => null);
      if (profile) {
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
      return { mcpConfigPath: null, cleanup: async () => {} };
    }
    const config = await buildClaudeMcpConfig(active, async (k) =>
      secretVault.read(k),
    );
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
    getApprovedCapabilityContexts: ({ taskRunId }) =>
      capabilityService.approvedPromptContexts({ taskRunId }),
    getApprovedLearnerModel: ({ taskRunId }) =>
      learnerAdvisor.approvedModelContext({ taskRunId }),
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

  // Phase 4b — real MCP probe.
  //   stdio  → spawn the command, send a JSON-RPC `initialize` request, wait
  //            ≤3s for a response line. Any successful JSON reply counts as
  //            healthy; non-zero exit / timeout / parse error counts as fail.
  //   http   → fetch the URL with method HEAD, 3s AbortController timeout.
  //   sse    → same as http; we just probe reachability, not the event stream.
  const mcpProbe = async (
    server: McpServerConfig,
  ): Promise<McpServerHealth> => {
    const checkedAt = new Date().toISOString();
    const okResult = (): McpServerHealth => ({ okAt: checkedAt, checkedAt });
    const failResult = (msg: string): McpServerHealth => ({
      error: msg.slice(0, 400),
      checkedAt,
    });

    if (server.transport === "stdio") {
      const { spawn } = await import("node:child_process");
      const command = server.command ?? "";
      const args = server.args ? [...server.args] : [];
      if (command.length === 0) return failResult("missing command");
      try {
        const child = spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        const probe = new Promise<McpServerHealth>((resolve) => {
          let resolved = false;
          const finish = (h: McpServerHealth): void => {
            if (resolved) return;
            resolved = true;
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
            resolve(h);
          };
          const timer = setTimeout(
            () => finish(failResult("probe timeout (3s)")),
            3000,
          );
          child.on("error", (e) => {
            clearTimeout(timer);
            finish(failResult(e.message));
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            if (!resolved) {
              finish(
                code === 0 ? okResult() : failResult(`exit ${code ?? "?"}`),
              );
            }
          });
          child.stdout?.on("data", (b: Buffer) => {
            const text = b.toString("utf8");
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              try {
                const obj = JSON.parse(trimmed);
                if (obj && typeof obj === "object") {
                  clearTimeout(timer);
                  finish(okResult());
                  return;
                }
              } catch {
                // not JSON — keep waiting for the next chunk
              }
            }
          });
          const initialize = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "HarnessAgentOS-probe", version: "0" },
            },
          });
          try {
            child.stdin?.write(`${initialize}\n`);
          } catch (e) {
            clearTimeout(timer);
            finish(failResult(e instanceof Error ? e.message : String(e)));
          }
        });
        return await probe;
      } catch (e) {
        return failResult(e instanceof Error ? e.message : String(e));
      }
    }

    // http / sse — light reachability check.
    const url = server.url ?? "";
    if (url.length === 0) return failResult("missing url");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      // Any HTTP status — even 4xx — means we reached the server, which is
      // enough for a transport-level probe. Network errors are the only fail.
      void res.status;
      return okResult();
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  };

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
  // Seed orchestration flag from persisted settings before IPC goes live.
  try {
    const s = await services.state.getSettings();
    services.onSettingsUpdate(s);
  } catch {
    // non-fatal; mutable ref stays false
  }
  // Phase 5a — seed the project/user skill-source sentinels so the new
  // Settings → Skills tab shows them on first launch. Idempotent: pre-
  // existing rows (including user-renamed sentinels) are left untouched.
  try {
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
  } catch {
    // non-fatal — UI just won't pre-populate the sentinels.
  }
  // Seed 4 example agent profiles (planner/coder/reviewer/tester) on first launch.
  try {
    await services.state.agentProfiles.ensureSeed();
  } catch {
    // non-fatal — UI still works with an empty profile list.
  }
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
