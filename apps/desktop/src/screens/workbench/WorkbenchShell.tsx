import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AgentProfile,
  AgentProviderStatusMap,
  Approval,
  LearnerContextDecisionSurface,
  ObservationRecallResult,
  OrchestrationMode,
  ProposedActionDetails,
  TaskRun,
} from "@harness/core";
import {
  evaluateBudget,
} from "@harness/core";
import { ThreadSidebar } from "./ThreadSidebar";
import { ConversationWorkbench } from "./ConversationWorkbench";
import type { ConversationMode } from "./ConversationInput";
import { RightPanel, type RightPanelTab } from "./RightPanel";
import { RuntimeStatusBar } from "./RuntimeStatusBar";
import { SettingsPanel } from "./SettingsPanel";
import { LearningPanel } from "./LearningPanel";
import { CommandPalette } from "./CommandPalette";
import { NotificationTray } from "./NotificationTray";
import type { CommandPaletteItem } from "./command-palette-model";
import { SlimRail } from "./SlimRail";
import { HeroEmpty } from "./HeroEmpty";
import type { AgentProgressItem } from "./AgentProgressList";
import {
  clampPanelWidth,
  createWorkbenchLayoutStyle,
  readStoredPanelWidth,
  resizePanelWidth,
  WORKBENCH_LAYOUT_LIMITS,
} from "./workbench-layout";
import {
  taskRunIdFromAgentStreamEvent,
  taskRunIdToRefreshForAgentEvent,
} from "./agent-panel-visibility";
import {
  hasPipelineSourcePlanArtifact,
  pipelineAutoApproveDecision,
} from "./pipeline-auto-approval";
import {
  beginTaskRunDetailRefresh,
  beginThreadDetailRefresh,
  type DetailState,
  type TaskRunDetailState,
  type ThreadsState,
} from "./workbench-refresh-state";
import "./workbench.css";

interface RecentTaskRunCommand {
  taskRun: TaskRun;
  threadId: string;
  threadTitle: string;
}

const COMMAND_TAB_ITEMS: ReadonlyArray<{
  id: RightPanelTab;
  title: string;
  keywords: readonly string[];
}> = [
  { id: "plan", title: "Plan", keywords: ["approval", "approvals"] },
  { id: "agent", title: "Agent", keywords: ["invocation", "cli"] },
  { id: "graph", title: "Agent Graph", keywords: ["topology"] },
  { id: "timeline", title: "Timeline", keywords: ["time"] },
  { id: "artifacts", title: "Files", keywords: ["artifacts"] },
  { id: "quality", title: "Quality", keywords: ["qa"] },
  { id: "orchestration", title: "Orchestration", keywords: ["orch"] },
  { id: "cost", title: "Cost", keywords: ["budget", "latency"] },
  { id: "decisions", title: "Decisions", keywords: ["auto approve"] },
];

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);


const taskRunTitle = (taskRun: TaskRun): string => {
  const trimmed = taskRun.userRequest.trim();
  if (trimmed.length <= 72) return trimmed;
  return `${trimmed.slice(0, 69)}...`;
};

export const WorkbenchShell = (): JSX.Element => {
  const [threadsState, setThreadsState] = useState<ThreadsState>({
    kind: "loading",
  });
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [selectedTaskRunId, setSelectedTaskRunId] = useState<string | null>(
    null,
  );
  const [taskRunDetail, setTaskRunDetail] = useState<TaskRunDetailState>({
    kind: "idle",
  });
  const [providers, setProviders] =
    useState<AgentProviderStatusMap | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [learningOpen, setLearningOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("plan");
  const [recentTaskRuns, setRecentTaskRuns] = useState<RecentTaskRunCommand[]>(
    [],
  );
  const [autoApprove, setAutoApprove] = useState(false);
  const [activeAgentProfile, setActiveAgentProfile] =
    useState<AgentProfile | null>(null);
  const [agentProgressByTaskRunId, setAgentProgressByTaskRunId] = useState<
    Record<string, AgentProgressItem[]>
  >({});
  const [
    pinnedObservationContextsByTaskRunId,
    setPinnedObservationContextsByTaskRunId,
  ] = useState<Record<string, ObservationRecallResult[]>>({});

  const pushAgentProgress = useCallback(
    (taskRunId: string, item: AgentProgressItem): void => {
      setAgentProgressByTaskRunId((prev) => {
        const nextItems = [...(prev[taskRunId] ?? []), item].slice(-12);
        return { ...prev, [taskRunId]: nextItems };
      });
    },
    [],
  );

  const noteAgentProgress = useCallback(
    (
      taskRunId: string,
      stage: AgentProgressItem["stage"],
      message: string,
      detail?: string,
    ): void => {
      pushAgentProgress(taskRunId, {
        stage,
        message,
        ...(detail !== undefined ? { detail } : {}),
        at: new Date().toISOString(),
      });
    },
    [pushAgentProgress],
  );

  // Suppresses a manual-plan button flash before the host plan arrives.
  // This renderer-local hint never grants approval or controls execution.
  const pipelineAutoTaskRunIdsRef = useRef<Set<string>>(new Set());
  const markPipelineAutoTaskRun = useCallback((taskRunId: string): void => {
    // UI flash suppression only. Persisted host plan owns approval consent.
    pipelineAutoTaskRunIdsRef.current.add(taskRunId);
  }, []);

  // V1 → V2 migration flag. Width keys (sidebarWidth/rightPanelWidth) carry
  // over with compatible semantics, so no value translation is needed; this
  // flag just records that the user has booted v2 at least once, in case a
  // future migration needs an anchor point.
  useEffect(() => {
    if (localStorage.getItem("workbench-v2-migrated") === "true") return;
    localStorage.setItem("workbench-v2-migrated", "true");
  }, []);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("workbench-theme");
    return saved === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("workbench-theme", theme);
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    return readStoredPanelWidth(
      localStorage.getItem("workbench-sidebar-width"),
      "thread",
    );
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    return readStoredPanelWidth(
      localStorage.getItem("workbench-right-width"),
      "context",
    );
  });
  const [dragging, setDragging] = useState<"sidebar" | "right" | null>(null);

  const [threadDrawerOpen, setThreadDrawerOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem("workbench-thread-drawer-open");
    return saved === null ? true : saved === "true";
  });
  const [contextDrawerOpen, setContextDrawerOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem("workbench-context-drawer-open");
    return saved === null ? false : saved === "true";
  });
  const [threadCreateRequest, setThreadCreateRequest] = useState(0);

  useEffect(() => {
    localStorage.setItem("workbench-thread-drawer-open", String(threadDrawerOpen));
  }, [threadDrawerOpen]);
  useEffect(() => {
    localStorage.setItem("workbench-context-drawer-open", String(contextDrawerOpen));
  }, [contextDrawerOpen]);

  // Keyboard shortcuts. Ctrl+B/J overlap with text-editing reflexes (bold,
  // line break) so skip when focus is in an editable element. Esc still
  // applies everywhere — it has no text-input meaning.
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      const editable = isEditableTarget(e.target);
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && !editable) {
        const key = e.key.toLowerCase();
        if (key === "b") {
          e.preventDefault();
          setThreadDrawerOpen((v) => !v);
          return;
        }
        if (key === "j") {
          e.preventDefault();
          setContextDrawerOpen((v) => !v);
          return;
        }
        if (key === ",") {
          e.preventDefault();
          setSettingsOpen(true);
          return;
        }
        if (key === "n") {
          e.preventDefault();
          setThreadDrawerOpen(true);
          setThreadCreateRequest((n) => n + 1);
          return;
        }
      }
      if (e.key === "Escape") {
        // Priority: command palette > learning/settings modals > rightmost drawer
        if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
          return;
        }
        if (learningOpen) {
          setLearningOpen(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (contextDrawerOpen) {
          setContextDrawerOpen(false);
          return;
        }
        if (threadDrawerOpen) {
          setThreadDrawerOpen(false);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    commandPaletteOpen,
    learningOpen,
    settingsOpen,
    contextDrawerOpen,
    threadDrawerOpen,
  ]);

  const dragRef = useRef<{
    type: "sidebar" | "right";
    startX: number;
    startWidth: number;
  } | null>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  sidebarWidthRef.current = sidebarWidth;
  rightPanelWidthRef.current = rightPanelWidth;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      if (drag.type === "sidebar") {
        setSidebarWidth(clampPanelWidth(drag.startWidth + delta, "thread"));
      } else {
        setRightPanelWidth(
          clampPanelWidth(drag.startWidth - delta, "context"),
        );
      }
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.type === "sidebar") {
        localStorage.setItem("workbench-sidebar-width", String(sidebarWidthRef.current));
      } else {
        localStorage.setItem("workbench-right-width", String(rightPanelWidthRef.current));
      }
      dragRef.current = null;
      setDragging(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const handleSidebarResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { type: "sidebar", startX: e.clientX, startWidth: sidebarWidthRef.current };
    setDragging("sidebar");
  }, []);

  const handleRightResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { type: "right", startX: e.clientX, startWidth: rightPanelWidthRef.current };
    setDragging("right");
  }, []);

  const handleResizerKeyDown = useCallback(
    (panel: "thread" | "context", e: React.KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();

      // 왼쪽 패널은 오른쪽으로, 오른쪽 패널은 왼쪽으로 이동할 때 넓어진다.
      const direction =
        panel === "thread"
          ? e.key === "ArrowRight"
            ? 1
            : -1
          : e.key === "ArrowLeft"
            ? 1
            : -1;
      const storageKey =
        panel === "thread"
          ? "workbench-sidebar-width"
          : "workbench-right-width";
      const updateWidth = (current: number): number => {
        const next = resizePanelWidth(current, panel, direction);
        localStorage.setItem(storageKey, String(next));
        return next;
      };

      if (panel === "thread") setSidebarWidth(updateWidth);
      else setRightPanelWidth(updateWidth);
    },
    [],
  );

  const agentAvailable =
    providers !== null &&
    providers.codex.available;

  const refreshThreads = useCallback(async () => {
    setThreadsState({ kind: "loading" });
    try {
      const threads = await window.harness.state.listThreads();
      setThreadsState({ kind: "ready", threads });
    } catch (e) {
      setThreadsState({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  const refreshThreadDetail = useCallback(
    async (threadId: string) => {
      setDetailState((previous) =>
        beginThreadDetailRefresh(previous, threadId),
      );
      try {
        const detail = await window.harness.state.getThread({ threadId });
        setDetailState({ kind: "ready", detail });
      } catch (e) {
        setDetailState({
          kind: "error",
          threadId,
          message: errorMessage(e),
        });
      }
    },
    [],
  );

  const handlePinnedObservationToggle = useCallback(
    (
      taskRunId: string,
      context: ObservationRecallResult,
      surface: LearnerContextDecisionSurface = "recall",
    ): void => {
      const current = pinnedObservationContextsByTaskRunId[taskRunId] ?? [];
      const exists = current.some(
        (item) => item.observationId === context.observationId,
      );
      const decision = exists ? "unpinned" : "pinned";
      setPinnedObservationContextsByTaskRunId((prev) => {
        const latest = prev[taskRunId] ?? [];
        const stillExists = latest.some(
          (item) => item.observationId === context.observationId,
        );
        const next = stillExists
          ? latest.filter((item) => item.observationId !== context.observationId)
          : [...latest, context].slice(-5);
        return { ...prev, [taskRunId]: next };
      });
      void window.harness.learner.recordContextDecision({
        taskRunId,
        observationId: context.observationId,
        decision,
        surface,
        score: context.score,
        ...(context.outcome?.reuseRisk
          ? { reuseRisk: context.outcome.reuseRisk }
          : {}),
      });
    },
    [pinnedObservationContextsByTaskRunId],
  );

  const refreshTaskRunDetail = useCallback(async (taskRunId: string) => {
    setTaskRunDetail((previous) =>
      beginTaskRunDetailRefresh(previous, taskRunId),
    );
    try {
      const detail = await window.harness.conversation.getTaskRunDetail({
        taskRunId,
      });
      setTaskRunDetail({ kind: "ready", detail });
    } catch (e) {
      setTaskRunDetail({
        kind: "error",
        taskRunId,
        message: errorMessage(e),
      });
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    if (!commandPaletteOpen || threadsState.kind !== "ready") return;
    let cancelled = false;
    void (async () => {
      try {
        const details = await Promise.all(
          threadsState.threads.map((thread) =>
            window.harness.state.getThread({ threadId: thread.id }),
          ),
        );
        if (cancelled) return;
        const next = details
          .flatMap((detail) =>
            detail.taskRuns.map((taskRun) => ({
              taskRun,
              threadId: detail.thread.id,
              threadTitle: detail.thread.title,
            })),
          )
          .sort((a, b) => b.taskRun.updatedAt.localeCompare(a.taskRun.updatedAt))
          .slice(0, 10);
        setRecentTaskRuns(next);
      } catch {
        if (!cancelled) setRecentTaskRuns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commandPaletteOpen, threadsState]);

  const refreshProviders = useCallback(async () => {
    try {
      const next = await window.harness.agent.checkProviders();
      setProviders(next);
      return next;
    } catch {
      setProviders(null);
      return null;
    }
  }, []);

  const refreshAutoApprove = useCallback(async () => {
    try {
      const s = await window.harness.settings.get();
      setAutoApprove(s.approval.autoApprove);
      // Also resolve which AgentProfile is active so the auto-approve
      // policy can layer per-profile permissions on top of the global flag.
      const profiles = await window.harness.agents.list();
      const activeId = s.activeAgentProfileId;
      const next =
        (activeId ? profiles.find((p) => p.id === activeId) : null) ??
        profiles.find((p) => p.isDefault) ??
        null;
      setActiveAgentProfile(next);
    } catch {
      setAutoApprove(false);
      setActiveAgentProfile(null);
    }
  }, []);

  useEffect(() => {
    void refreshAutoApprove();
  }, [refreshAutoApprove]);

  useEffect(() => {
    void refreshProviders();
    const off = window.harness.events.onAgentStreamEvent((event) => {
      const refreshTaskRunId = taskRunIdToRefreshForAgentEvent({
        eventType: event.type,
        selectedTaskRunId,
        eventTaskRunId: taskRunIdFromAgentStreamEvent(event),
      });
      if (event.type === "progress") {
        pushAgentProgress(event.taskRunId, event);
      }
      if (refreshTaskRunId !== null && selectedTaskRunId === refreshTaskRunId) {
        void refreshTaskRunDetail(refreshTaskRunId);
      }
      if (selectedThreadId && refreshTaskRunId !== null) {
        void refreshThreadDetail(selectedThreadId);
      }
      if (
        event.type === "started" ||
        event.type === "result" ||
        event.type === "failed"
      ) {
        void refreshProviders();
      }
    });
    return off;
  }, [
    pushAgentProgress,
    refreshProviders,
    refreshTaskRunDetail,
    refreshThreadDetail,
    selectedTaskRunId,
    selectedThreadId,
  ]);

  useEffect(() => {
    if (selectedThreadId === null) {
      setDetailState({ kind: "idle" });
      setSelectedTaskRunId(null);
      return;
    }
    void refreshThreadDetail(selectedThreadId);
  }, [selectedThreadId, refreshThreadDetail]);

  useEffect(() => {
    if (selectedTaskRunId === null) {
      setTaskRunDetail({ kind: "idle" });
      return;
    }
    void refreshTaskRunDetail(selectedTaskRunId);
  }, [selectedTaskRunId, refreshTaskRunDetail]);

  // Subscribe to main → renderer push so the workbench refetches when the
  // active TaskRun row changes. The thread sidebar also follows along so
  // status pills don't go stale when an approval lands in the background.
  useEffect(() => {
    const off = window.harness.events.onTaskRunChanged(({ taskRunId }) => {
      if (selectedTaskRunId && taskRunId === selectedTaskRunId) {
        void refreshTaskRunDetail(taskRunId);
      }
      if (selectedThreadId) {
        void refreshThreadDetail(selectedThreadId);
      }
    });
    return off;
  }, [
    selectedTaskRunId,
    selectedThreadId,
    refreshTaskRunDetail,
    refreshThreadDetail,
  ]);

  // Approval execution is owned by main. Renderer only subscribes to persisted changes.

  const handleCreateThread = useCallback(
    async (input: {
      title: string;
      targetDir?: string;
      pipelineId?: string;
    }): Promise<void> => {
      const created = await window.harness.state.createThread(input);
      await refreshThreads();
      setSelectedThreadId(created.id);
      setSelectedTaskRunId(null);
    },
    [refreshThreads],
  );

  const handleCreateTask = useCallback(
    async (input: {
      userRequest: string;
      intent?: import("@harness/core").TaskIntent;
      targetDir?: string;
      mode: ConversationMode;
      followUpTaskRunId?: string;
      orchMode?: OrchestrationMode;
      orchInstruction?: string;
      orchPipelineId?: string;
      orchHarness?: {
        packageId: string;
        workflowId?: string;
        bindingSetId: string;
      };
    }): Promise<void> => {
      if (!selectedThreadId) {
        throw new Error("스레드를 먼저 선택하세요");
      }
      const { mode: _mode, ...request } = input;
      const draft = await window.harness.conversation.startTask({
        ...request, threadId: selectedThreadId,
      });
      const contract = draft.taskRun.contract;
      if (contract?.authorization.mode !== "read_only" && contract?.externalSearch !== "forbidden" &&
          (input.orchPipelineId || input.orchHarness)) {
        markPipelineAutoTaskRun(draft.taskRun.id);
      }
      setSelectedTaskRunId(draft.taskRun.id);
      noteAgentProgress(draft.taskRun.id, "context", "작업 시작 준비",
        "메인에서 추천·승인·실행을 이어갑니다. 다른 작업으로 이동해도 진행됩니다.");
      await refreshThreadDetail(selectedThreadId);
    },
    [selectedThreadId, refreshThreadDetail, markPipelineAutoTaskRun, noteAgentProgress],
  );

  const handleAgentGenerate = useCallback(
    async (taskRunId: string): Promise<void> => {
      noteAgentProgress(
        taskRunId,
        "context",
        "에이전트 시작 준비",
        "Provider 상태, 프로필, 최근 컨텍스트를 확인하는 중",
      );
      await window.harness.agent.generatePlan({
        taskRunId,
        pinnedObservationContexts:
          pinnedObservationContextsByTaskRunId[taskRunId] ?? [],
      });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [
      noteAgentProgress,
      pinnedObservationContextsByTaskRunId,
      refreshTaskRunDetail,
      selectedTaskRunId,
    ],
  );

  const handleAgentRetry = useCallback(
    async (invocationId: string): Promise<void> => {
      if (selectedTaskRunId) {
        noteAgentProgress(
          selectedTaskRunId,
          "queued",
          "에이전트 재시도 준비",
          invocationId,
        );
      }
      await window.harness.agent.retryInvocation({ invocationId });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [noteAgentProgress, refreshTaskRunDetail, selectedTaskRunId],
  );

  const handleAgentCancel = useCallback(
    async (invocationId: string): Promise<void> => {
      await window.harness.agent.cancelInvocation({ invocationId });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [refreshTaskRunDetail, selectedTaskRunId],
  );

  const handleAgentUseFallback = useCallback(
    async (taskRunId: string): Promise<void> => {
      await window.harness.agent.useTemplateFallback({ taskRunId });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [refreshTaskRunDetail, selectedTaskRunId],
  );

  const handleDeleteThread = useCallback(
    async (id: string): Promise<void> => {
      await window.harness.state.deleteThread({ threadId: id });
      if (selectedThreadId === id) {
        setSelectedThreadId(null);
        setSelectedTaskRunId(null);
        setDetailState({ kind: "idle" });
      }
      await refreshThreads();
    },
    [refreshThreads, selectedThreadId],
  );

  const handleDeleteTask = useCallback(
    async (id: string): Promise<void> => {
      await window.harness.conversation.deleteTask({ taskRunId: id });
      setPinnedObservationContextsByTaskRunId((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (selectedTaskRunId === id) setSelectedTaskRunId(null);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    },
    [refreshThreadDetail, selectedTaskRunId, selectedThreadId],
  );

  const handleApprove = useCallback(
    async (input: {
      approvalId: string;
      expectedRevision: number;
      manualConfirmation?: boolean;
      message?: string;
      scope?: "once" | "run_action_class";
    }): Promise<void> => {
      await window.harness.conversation.approve(input);
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    },
    [
      refreshTaskRunDetail,
      refreshThreadDetail,
      selectedTaskRunId,
      selectedThreadId,
    ],
  );

  const handleReject = useCallback(
    async (input: {
      approvalId: string;
      message: string;
    }): Promise<void> => {
      await window.harness.conversation.rejectApproval(input);
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    },
    [
      refreshTaskRunDetail,
      refreshThreadDetail,
      selectedTaskRunId,
      selectedThreadId,
    ],
  );

  const handleRedirect = useCallback(
    async (input: { instruction: string }): Promise<void> => {
      if (!selectedTaskRunId) throw new Error("재계획할 TaskRun이 없습니다");
      await window.harness.conversation.redirectTask({
        taskRunId: selectedTaskRunId,
        instruction: input.instruction,
      });
      await refreshTaskRunDetail(selectedTaskRunId);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    },
    [
      refreshTaskRunDetail,
      refreshThreadDetail,
      selectedTaskRunId,
      selectedThreadId,
    ],
  );

  const handleConfigure = useCallback(
    async (input: {
      approvalId: string;
      details: ProposedActionDetails;
    }): Promise<void> => {
      await window.harness.conversation.setProposedAction(input);
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [refreshTaskRunDetail, selectedTaskRunId],
  );

  const handleExecute = useCallback(
    async (input: { approvalId: string }): Promise<void> => {
      await window.harness.runner.executeApproved(input);
      if (selectedTaskRunId) {
        await refreshTaskRunDetail(selectedTaskRunId);
      }
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    },
    [refreshTaskRunDetail, refreshThreadDetail, selectedTaskRunId, selectedThreadId],
  );

  const handleQualityChanged = useCallback(async (): Promise<void> => {
    if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
  }, [
    refreshTaskRunDetail,
    refreshThreadDetail,
    selectedTaskRunId,
    selectedThreadId,
  ]);

  const selectedThread =
    detailState.kind === "ready" ? detailState.detail.thread : null;

  const threadCount =
    threadsState.kind === "ready" ? threadsState.threads.length : 0;
  const hasSelectedTaskRun = selectedTaskRunId !== null;
  const pendingApprovalCount =
    taskRunDetail.kind === "ready"
      ? taskRunDetail.detail.approvals.filter((a) => a.status === "pending").length
      : 0;

  // SlimRail intents
  const openThreadDrawer = useCallback(() => setThreadDrawerOpen(true), []);
  const toggleThreadDrawer = useCallback(
    () => setThreadDrawerOpen((v) => !v),
    [],
  );
  const toggleContextDrawer = useCallback(
    () => setContextDrawerOpen((v) => !v),
    [],
  );
  const handleNewThreadFromRail = useCallback(() => {
    setThreadDrawerOpen(true);
    // Bump a counter so ThreadSidebar receives a fresh "start create" signal
    // each click, even when the drawer was already open.
    setThreadCreateRequest((n) => n + 1);
  }, []);

  // When a TaskRun gets selected, auto-open the context drawer so approvals
  // and plan output are immediately visible. Don't auto-close on deselect —
  // leave the user's choice intact.
  const prevSelectedTaskRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      selectedTaskRunId !== null &&
      prevSelectedTaskRunIdRef.current === null &&
      !contextDrawerOpen
    ) {
      setContextDrawerOpen(true);
    }
    prevSelectedTaskRunIdRef.current = selectedTaskRunId;
  }, [selectedTaskRunId, contextDrawerOpen]);

  // Pending approval should pull the user's attention to the context drawer —
  // but only the FIRST time a given TaskRun has pending approvals. If the
  // user explicitly closes the drawer during an active run, subsequent
  // approval events shouldn't keep re-opening it. Auto approval never means
  // that mandatory individual confirmations can be hidden.
  const autoOpenedForTaskRunRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedTaskRunId) return;
    if (pendingApprovalCount === 0) return;
    if (autoOpenedForTaskRunRef.current.has(selectedTaskRunId)) return;
    autoOpenedForTaskRunRef.current.add(selectedTaskRunId);
    if (!contextDrawerOpen) setContextDrawerOpen(true);
  }, [pendingApprovalCount, contextDrawerOpen, selectedTaskRunId]);

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = COMMAND_TAB_ITEMS.map((tab) => ({
      id: `tab:${tab.id}`,
      group: "tab",
      title: tab.title,
      subtitle: "Open right panel tab",
      keywords: tab.keywords,
      run: () => {
        setContextDrawerOpen(true);
        setRightPanelTab(tab.id);
      },
    }));

    items.push({
      id: "learning:open",
      group: "learning",
      title: "Learning",
      subtitle: "Open instincts, capabilities, learner, and skills",
      keywords: [
        "instinct",
        "capability",
        "caps",
        "skills",
        "skillify",
        "learner",
      ],
      run: () => setLearningOpen(true),
    });

    items.push({
      id: "settings:open",
      group: "settings",
      title: "Settings",
      subtitle: "Open settings",
      keywords: ["preferences", "configuration"],
      run: () => setSettingsOpen(true),
    });

    if (threadsState.kind === "ready") {
      for (const thread of threadsState.threads) {
        items.push({
          id: `thread:${thread.id}`,
          group: "thread",
          title: thread.title,
          subtitle: thread.targetDir ?? "Thread",
          keywords: [thread.id, thread.targetDir ?? ""],
          run: () => {
            setThreadDrawerOpen(true);
            setSelectedThreadId(thread.id);
            setSelectedTaskRunId(null);
          },
        });
      }
    }

    for (const recent of recentTaskRuns) {
      items.push({
        id: `taskrun:${recent.taskRun.id}`,
        group: "taskrun",
        title: taskRunTitle(recent.taskRun),
        subtitle: `${recent.threadTitle} · ${recent.taskRun.status}`,
        keywords: [
          recent.taskRun.id,
          recent.taskRun.userRequest,
          recent.threadTitle,
        ],
        run: () => {
          setThreadDrawerOpen(true);
          setContextDrawerOpen(true);
          setSelectedThreadId(recent.threadId);
          setSelectedTaskRunId(recent.taskRun.id);
        },
      });
    }

    return items;
  }, [recentTaskRuns, threadsState]);

  return (
    <div
      className={`workbench${threadDrawerOpen ? " workbench--thread-open" : ""}${contextDrawerOpen ? " workbench--context-open" : ""}`}
      style={createWorkbenchLayoutStyle(sidebarWidth, rightPanelWidth) as CSSProperties}
    >
      <SlimRail
        threadCount={threadCount}
        threadDrawerOpen={threadDrawerOpen}
        contextDrawerOpen={contextDrawerOpen}
        learningOpen={learningOpen}
        hasSelectedTaskRun={hasSelectedTaskRun}
        theme={theme}
        onToggleThreadDrawer={toggleThreadDrawer}
        onToggleContextDrawer={toggleContextDrawer}
        onOpenLearning={() => setLearningOpen(true)}
        onNewThread={handleNewThreadFromRail}
        onToggleTheme={handleToggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <aside
        className={`thread-drawer${threadDrawerOpen ? " thread-drawer--open" : ""}`}
        aria-hidden={!threadDrawerOpen}
      >
        <ThreadSidebar
          state={threadsState}
          selectedThreadId={selectedThreadId}
          onSelectThread={(id) => {
            setSelectedThreadId(id);
            setSelectedTaskRunId(null);
          }}
          onCreateThread={handleCreateThread}
          onDeleteThread={handleDeleteThread}
          onRetry={() => void refreshThreads()}
          startCreateSignal={threadCreateRequest}
        />
        {threadDrawerOpen && (
          <div
            className={`workbench-resizer workbench-resizer--thread${dragging === "sidebar" ? " workbench-resizer--dragging" : ""}`}
            role="separator"
            aria-label="스레드 패널 너비 조절"
            aria-orientation="vertical"
            aria-valuemin={WORKBENCH_LAYOUT_LIMITS.thread.min}
            aria-valuemax={WORKBENCH_LAYOUT_LIMITS.thread.max}
            aria-valuenow={Math.round(sidebarWidth)}
            tabIndex={0}
            onMouseDown={handleSidebarResizerMouseDown}
            onKeyDown={(e) => handleResizerKeyDown("thread", e)}
          />
        )}
      </aside>

      <>
          {selectedThreadId === null && threadCount === 0 ? (
            <main
              className="conversation-workbench"
              aria-label="Conversation workbench"
            >
              <HeroEmpty
                variant="no-thread"
                onCreateThread={handleNewThreadFromRail}
              />
            </main>
          ) : (
            <ConversationWorkbench
              detailState={detailState}
              selectedTaskRunId={selectedTaskRunId}
              onSelectTaskRun={setSelectedTaskRunId}
              onDeleteTask={handleDeleteTask}
              onCreateTask={handleCreateTask}
              threadTargetDir={selectedThread?.targetDir}
              threadId={selectedThreadId}
              threadPipelineId={selectedThread?.pipelineId}
              agentAvailable={agentAvailable}
              onCheckProviders={refreshProviders}
              contextDrawerOpen={contextDrawerOpen}
              onToggleContextDrawer={toggleContextDrawer}
              pendingApprovalCount={pendingApprovalCount}
              autoApprove={autoApprove}
              onOpenThreadDrawer={openThreadDrawer}
              activeTaskRunId={selectedTaskRunId}
              activeTaskRun={
                taskRunDetail.kind === "ready"
                  ? taskRunDetail.detail.taskRun
                  : null
              }
              activeTaskRunSteps={
                taskRunDetail.kind === "ready" ? taskRunDetail.detail.steps : []
              }
              activeTaskRunApprovals={
                taskRunDetail.kind === "ready"
                  ? taskRunDetail.detail.approvals
                  : []
              }
              activeTaskRunInvocations={
                taskRunDetail.kind === "ready"
                  ? taskRunDetail.detail.agentInvocations
                  : []
              }
              activeTaskRunArtifacts={
                taskRunDetail.kind === "ready"
                  ? taskRunDetail.detail.artifacts
                  : []
              }
              agentProgressByTaskRunId={agentProgressByTaskRunId}
            />
          )}
          <aside
            className={`context-drawer${contextDrawerOpen ? " context-drawer--open" : ""}`}
            aria-hidden={!contextDrawerOpen}
          >
            <RightPanel
              state={taskRunDetail}
              onApprove={handleApprove}
              onReject={handleReject}
              onRedirect={handleRedirect}
              onConfigure={handleConfigure}
              onExecute={handleExecute}
              onQualityChanged={handleQualityChanged}
              onAgentGenerate={handleAgentGenerate}
              onAgentRetry={handleAgentRetry}
              onAgentCancel={handleAgentCancel}
              onAgentUseFallback={handleAgentUseFallback}
              agentAvailable={agentAvailable}
              activeTab={rightPanelTab}
              onActiveTabChange={setRightPanelTab}
              pipelineAutoLaunched={
                selectedTaskRunId !== null &&
                pipelineAutoTaskRunIdsRef.current.has(selectedTaskRunId)
              }
              getPipelineAutoDecision={(approval) => {
                const usage =
                  taskRunDetail.kind === "ready"
                    ? taskRunDetail.detail.budgetUsage
                    : undefined;
                return pipelineAutoApproveDecision(approval, {
                  activeProfile: activeAgentProfile,
                  accumulatedTaskRunCostUsd:
                    usage?.accumulatedTaskRunCostUsd ?? 0,
                  accumulatedDailyCostUsd:
                    usage?.accumulatedDailyCostUsd ?? 0,
                });
              }}
            />
            {contextDrawerOpen && (
              <div
                className={`workbench-resizer workbench-resizer--context${dragging === "right" ? " workbench-resizer--dragging" : ""}`}
                role="separator"
                aria-label="컨텍스트 패널 너비 조절"
                aria-orientation="vertical"
                aria-valuemin={WORKBENCH_LAYOUT_LIMITS.context.min}
                aria-valuemax={WORKBENCH_LAYOUT_LIMITS.context.max}
                aria-valuenow={Math.round(rightPanelWidth)}
                tabIndex={0}
                onMouseDown={handleRightResizerMouseDown}
                onKeyDown={(e) => handleResizerKeyDown("context", e)}
              />
            )}
          </aside>
        </>
      <RuntimeStatusBar />
      <NotificationTray />
      {commandPaletteOpen && (
        <CommandPalette
          items={commandPaletteItems}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
      {learningOpen && (
        <LearningPanel
          taskRun={
            taskRunDetail.kind === "ready"
              ? taskRunDetail.detail.taskRun
              : null
          }
          approvals={
            taskRunDetail.kind === "ready" ? taskRunDetail.detail.approvals : []
          }
          profileId={activeAgentProfile?.id ?? null}
          onApprovalCreated={handleQualityChanged}
          pinnedObservationIds={
            taskRunDetail.kind === "ready"
              ? (
                  pinnedObservationContextsByTaskRunId[
                    taskRunDetail.detail.taskRun.id
                  ] ?? []
                ).map((context) => context.observationId)
              : []
          }
          onPinnedObservationToggle={(context, surface) => {
            if (taskRunDetail.kind !== "ready") return;
            handlePinnedObservationToggle(
              taskRunDetail.detail.taskRun.id,
              context,
              surface,
            );
          }}
          onClose={() => setLearningOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          initialTopologyTaskRunId={selectedTaskRunId}
          onClose={() => {
            setSettingsOpen(false);
            void refreshAutoApprove();
          }}
        />
      )}
    </div>
  );
};
