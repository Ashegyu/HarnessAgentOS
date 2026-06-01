import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProfile,
  AgentProviderStatusMap,
  Approval,
  AutoApproveDecision,
  LearnerContextDecisionSurface,
  ObservationRecallResult,
  OrchestrationMode,
  ProposedActionDetails,
  TaskRun,
  TaskRunDetail,
} from "@harness/core";
import {
  evaluateBudget,
  isWorkerFileActionApproval,
  shouldAutoApprove,
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
  taskRunIdFromAgentStreamEvent,
  taskRunIdToRefreshForAgentEvent,
} from "./agent-panel-visibility";
import {
  hasPipelineSourcePlanArtifact,
  pipelineAutoApproveDecision,
} from "./pipeline-auto-approval";
import {
  autoExecutableRunnerApprovalIssue,
  buildAutoApprovedExecutionPlan,
  canRunAutoApprovedExecutionForStatus,
  isApprovedForPipelineAutoExecution,
  isRunnerExecutionApproval,
  runAutoApprovedExecutionPlan,
} from "./auto-execution-plan";
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

const continuationOrchestrationApprovalIds = (
  detail: TaskRunDetail,
  excludeIds: ReadonlySet<string> = new Set(),
): string[] =>
  detail.approvals
    .filter(
      (approval) =>
        approval.actionType === "orchestration_plan" &&
        !excludeIds.has(approval.id) &&
        (approval.status === "approved" ||
          approval.status === "always_approved_for_run"),
    )
    .map((approval) => approval.id);

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
  const [autoExecuteWorkerFileActions, setAutoExecuteWorkerFileActions] =
    useState(false);
  const [activeAgentProfile, setActiveAgentProfile] =
    useState<AgentProfile | null>(null);
  const [agentProgressByTaskRunId, setAgentProgressByTaskRunId] = useState<
    Record<string, AgentProgressItem[]>
  >({});
  const [
    pinnedObservationContextsByTaskRunId,
    setPinnedObservationContextsByTaskRunId,
  ] = useState<Record<string, ObservationRecallResult[]>>({});
  // Tracks approval IDs that the auto-approver has already kicked off so
  // the effect doesn't double-fire on the eventual taskRunChanged event
  // before the row's status flips out of "pending".
  const autoInFlightRef = useRef<Set<string>>(new Set());
  const advisoryResumeInFlightRef = useRef<Set<string>>(new Set());

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

  // Tracks TaskRun IDs that were created via pipeline-pick at submit
  // time. For these runs we auto-approve the orchestration_plan and any
  // well-formed runner approvals that can actually execute. Picking a
  // pipeline is itself the user's consent, but malformed runner payloads
  // remain pending for manual repair.
  const pipelineAutoTaskRunIdsRef = useRef<Set<string>>(new Set());
  const PIPELINE_AUTO_LS_KEY = "harness.pipelineAutoTaskRunIds";
  // Initial load — pre-populate the Set from localStorage so reloads
  // mid-run don't lose the auto-approve consent.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PIPELINE_AUTO_LS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        pipelineAutoTaskRunIdsRef.current = new Set(
          parsed.filter((x): x is string => typeof x === "string"),
        );
      }
    } catch {
      // Corrupt LS — drop silently; worst case the user re-consents on
      // their next pipeline submission.
    }
  }, []);
  const markPipelineAutoTaskRun = useCallback((taskRunId: string): void => {
    pipelineAutoTaskRunIdsRef.current.add(taskRunId);
    try {
      window.localStorage.setItem(
        PIPELINE_AUTO_LS_KEY,
        JSON.stringify(Array.from(pipelineAutoTaskRunIdsRef.current)),
      );
    } catch {
      // Quota / disabled storage — in-memory Set still works for this
      // session, just won't survive reload.
    }
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
    const saved = localStorage.getItem("workbench-sidebar-width");
    return saved ? Math.max(180, Math.min(400, Number(saved))) : 280;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const saved = localStorage.getItem("workbench-right-width");
    return saved ? Math.max(280, Math.min(600, Number(saved))) : 400;
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
        setSidebarWidth(Math.max(180, Math.min(400, drag.startWidth + delta)));
      } else {
        setRightPanelWidth(Math.max(280, Math.min(600, drag.startWidth - delta)));
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

  const agentAvailable =
    providers !== null &&
    (providers.claude.available || providers.codex.available);

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
    } catch {
      setProviders(null);
    }
  }, []);

  const refreshAutoApprove = useCallback(async () => {
    try {
      const s = await window.harness.settings.get();
      setAutoApprove(s.approval.autoApprove);
      setAutoExecuteWorkerFileActions(
        s.approval.autoExecuteWorkerFileActions,
      );
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
      setAutoExecuteWorkerFileActions(false);
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

  // Auto-approve + auto-execute. Combines three triggers:
  //   1. The global `approval.autoApprove` toggle.
  //   2. The active AgentProfile's per-action permissions.
  //   3. The narrow worker-file automation toggle.
  //   4. Pipeline-pick consent (this TaskRun was started by picking a
  //      pipeline in ConversationInput — every approval it produces is
  //      pre-approved, including downstream worker actions).
  //
  // The active profile's BLOCK LIST is a hard floor for non-pipeline
  // auto-approve triggers. Pipeline-pick consent is scoped by the
  // pipeline's own step allowedActions and service policy, not the
  // currently selected UI profile; otherwise a read-only active
  // profile can strand approved pipeline/backflow worker actions in
  // waiting_for_approval.
  useEffect(() => {
    if (taskRunDetail.kind !== "ready") return;
    const inFlight = autoInFlightRef.current;
    const taskRunId = taskRunDetail.detail.taskRun.id;
    if (
      !canRunAutoApprovedExecutionForStatus(taskRunDetail.detail.taskRun.status)
    ) {
      return;
    }
    const isPipelineAutoTask =
      pipelineAutoTaskRunIdsRef.current.has(taskRunId) ||
      hasPipelineSourcePlanArtifact(taskRunDetail.detail.artifacts);
    if (
      isPipelineAutoTask &&
      !pipelineAutoTaskRunIdsRef.current.has(taskRunId)
    ) {
      markPipelineAutoTaskRun(taskRunId);
    }
    const blockedActions =
      activeAgentProfile?.permissions.blockedActions ?? [];
    const budgetUsage = taskRunDetail.detail.budgetUsage;
    const isWorkerFileAction = (approval: Approval): boolean =>
      isWorkerFileActionApproval({
        approval,
        checkpoints: taskRunDetail.detail.checkpoints,
      });
    const isBudgetBlocked = (approval: Approval): boolean =>
      evaluateBudget({
        approval,
        profile: activeAgentProfile,
        accumulatedTaskRunCostUsd:
          budgetUsage?.accumulatedTaskRunCostUsd ?? 0,
        accumulatedDailyCostUsd:
          budgetUsage?.accumulatedDailyCostUsd ?? 0,
      }).kind === "blocked";
    const autoApproveDecisions = new Map<string, AutoApproveDecision>();
    const autoApproveMessage = (approval: Approval): string => {
      if (isPipelineAutoTask) return "auto-approved (pipeline task)";
      if (
        autoExecuteWorkerFileActions &&
        isWorkerFileAction(approval)
      ) {
        return "auto-approved (settings.approval.autoExecuteWorkerFileActions)";
      }
      return "auto-approved (settings.approval.autoApprove)";
    };
    const pending = taskRunDetail.detail.approvals.filter(
      (a: Approval): boolean => {
        if (a.status !== "pending") return false;
        if (inFlight.has(a.id)) return false;
        if (
          isRunnerExecutionApproval(a) &&
          autoExecutableRunnerApprovalIssue(a) !== null
        ) {
          return false;
        }
        if (isPipelineAutoTask) {
          const decision = pipelineAutoApproveDecision(a);
          autoApproveDecisions.set(a.id, decision);
          return decision.approved;
        }
        // Block list trumps non-pipeline auto-approve triggers.
        if (blockedActions.includes(a.actionType)) return false;
        if (isBudgetBlocked(a)) return false;
        const decision = shouldAutoApprove({
          approval: a,
          globalAutoApprove: autoApprove,
          activeProfile: activeAgentProfile,
          accumulatedTaskRunCostUsd:
            budgetUsage?.accumulatedTaskRunCostUsd ?? 0,
          accumulatedDailyCostUsd:
            budgetUsage?.accumulatedDailyCostUsd ?? 0,
          workerFileActionAutoApprove: autoExecuteWorkerFileActions,
          isWorkerFileAction: isWorkerFileAction(a),
        });
        if (decision.approved) autoApproveDecisions.set(a.id, decision);
        return decision.approved;
      },
    );
    const alreadyApprovedForAutoExecute = taskRunDetail.detail.approvals.filter(
      (a: Approval): boolean => {
        if (inFlight.has(a.id)) return false;
        if (!isPipelineAutoTask) return false;
        return isApprovedForPipelineAutoExecution(a);
      },
    );
    if (pending.length === 0 && alreadyApprovedForAutoExecute.length === 0) {
      return;
    }
    void (async () => {
      const approvedIds = new Set<string>();
      for (const approval of pending) {
        inFlight.add(approval.id);
        try {
          await window.harness.conversation.approve({
            approvalId: approval.id,
            message: autoApproveMessage(approval),
            autoApproveDecision:
              autoApproveDecisions.get(approval.id) ?? null,
          });
          approvedIds.add(approval.id);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("auto-approve failed", approval.id, e);
          // Drop from in-flight so a future refresh can retry rather than
          // silently leaving the approval stuck in pending.
          inFlight.delete(approval.id);
        }
      }
      for (const approval of alreadyApprovedForAutoExecute) {
        inFlight.add(approval.id);
        approvedIds.add(approval.id);
      }
      const approvalsForExecution = [
        ...pending.filter((approval) => approvedIds.has(approval.id)),
        ...alreadyApprovedForAutoExecute,
      ];
      const executionApprovalIds = new Set(
        approvalsForExecution.map((approval) => approval.id),
      );
      const executionPlan = buildAutoApprovedExecutionPlan(
        taskRunId,
        approvalsForExecution,
      );
      const runResult = await runAutoApprovedExecutionPlan({
        executionPlan: {
          ...executionPlan,
          continuationOrchestrationApprovalIds:
            isPipelineAutoTask || hasPipelineSourcePlanArtifact(taskRunDetail.detail.artifacts)
              ? continuationOrchestrationApprovalIds(
                  taskRunDetail.detail,
                  executionApprovalIds,
                )
              : [],
        },
        isPipelineAutoTask,
        api: {
          runOrchestrationApproved: (input) =>
            window.harness.orchestration.runApproved(input),
          executeCodeChangeAttempt: (input) =>
            window.harness.runner.executeCodeChangeAttempt(input),
          createRepairPlan: (input) =>
            window.harness.quality.createRepairPlan(input),
          executeApproved: (input) =>
            window.harness.runner.executeApproved(input),
        },
        onError: (context, error) => {
          // eslint-disable-next-line no-console
          console.error("auto execution failed", context, error);
        },
      });
      for (const approvalId of runResult.failedApprovalIds) {
        // Drop from in-flight so a future refresh can retry rather than
        // silently leaving the approval stuck in "approved but not run".
        inFlight.delete(approvalId);
      }
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    })();
  }, [
    autoApprove,
    autoExecuteWorkerFileActions,
    activeAgentProfile,
    taskRunDetail,
    markPipelineAutoTaskRun,
    selectedTaskRunId,
    selectedThreadId,
    refreshTaskRunDetail,
    refreshThreadDetail,
  ]);

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
      // Routing is now per-message: whatever ConversationInput's
      // dropdown carries in `input.orchPipelineId` is what gets used.
      // `Thread.pipelineId` only seeds the dropdown's initial value
      // (so threads "remember" the user's last choice). The user
      // freely changes it for every submission.
      const usingPipeline =
        input.orchPipelineId !== undefined && input.orchPipelineId.length > 0;
      const usingHarness =
        input.orchHarness !== undefined &&
        input.orchHarness.packageId.length > 0 &&
        input.orchHarness.bindingSetId.length > 0;
      const usingOrchestrationPick = usingPipeline || usingHarness;
      const payload: {
        threadId: string;
        userRequest: string;
        targetDir?: string;
        followUpTaskRunId?: string;
        mode: ConversationMode;
      } = {
        threadId: selectedThreadId,
        userRequest: input.userRequest,
        mode: input.mode,
      };
      if (input.targetDir !== undefined) payload.targetDir = input.targetDir;
      if (input.followUpTaskRunId !== undefined) {
        payload.followUpTaskRunId = input.followUpTaskRunId;
      }
      const draft = await window.harness.conversation.createTask(payload);
      // Mark this TaskRun as pipeline-auto BEFORE the render that
      // mounts the detail panels. There's a race window between the
      // setSelectedTaskRunId → first taskRunDetail fetch and the
      // orchestration.draftPlan call below: if we only mark inside
      // the draftPlan branch, the first render of AgentPanel sees
      // no orchestration_plan approval and would show the "Agent
      // plan 생성" button. Pre-marking lets RightPanel pass
      // `pipelineAutoLaunched` through to AgentPanel on the very
      // first render so the manual button never flashes.
      if (usingOrchestrationPick) markPipelineAutoTaskRun(draft.taskRun.id);
      setSelectedTaskRunId(draft.taskRun.id);
      if (input.followUpTaskRunId !== undefined) {
        noteAgentProgress(
          draft.taskRun.id,
          "context",
          "이전 Task 이어받기",
          input.followUpTaskRunId,
        );
      }
      let advisoryApprovalCount = 0;
      if (input.mode === "agent" && !usingOrchestrationPick) {
        try {
          const capabilityCandidates =
            await window.harness.capability.proposeCandidates({
              taskRunId: draft.taskRun.id,
              prompt: input.userRequest,
              profileId: activeAgentProfile?.id ?? null,
            });
          advisoryApprovalCount += capabilityCandidates.approvals.length;
          if (capabilityCandidates.approvals.length > 0) {
            noteAgentProgress(
              draft.taskRun.id,
              "context",
              "Skill 후보 승인 대기",
              `${capabilityCandidates.approvals.length}개 후보가 자동으로 올라갔습니다. 승인하면 다음 Agent 프롬프트에 반영됩니다.`,
            );
          }
        } catch (e) {
          noteAgentProgress(
            draft.taskRun.id,
            "context",
            "Skill 후보 확인 실패",
            errorMessage(e),
          );
        }
        try {
          const learnerCandidates =
            await window.harness.learner.proposeRecommendation({
              taskRunId: draft.taskRun.id,
            });
          advisoryApprovalCount += learnerCandidates.approvals.length;
          if (learnerCandidates.approvals.length > 0) {
            noteAgentProgress(
              draft.taskRun.id,
              "context",
              "Learner 추천 승인 대기",
              `${learnerCandidates.approvals.length}개 추천이 과거 trace 기반 후보로 올라갔습니다. 승인하면 다음 Agent 호출에 반영됩니다.`,
            );
          }
        } catch (e) {
          noteAgentProgress(
            draft.taskRun.id,
            "context",
            "Learner 추천 확인 실패",
            errorMessage(e),
          );
        }
      }
      // Agent mode: chain into generatePlan immediately so the user
      // sees streaming output instead of a sitting-still placeholder.
      // Skipped when the message routes through a pipeline —
      // orchestration owns the response generation in that case.
      if (
        input.mode === "agent" &&
        !usingOrchestrationPick &&
        advisoryApprovalCount === 0
      ) {
        noteAgentProgress(
          draft.taskRun.id,
          "context",
          "에이전트 시작 준비",
          "Provider 상태, 프로필, 최근 컨텍스트를 확인하는 중",
        );
        try {
          await window.harness.agent.generatePlan({
            taskRunId: draft.taskRun.id,
            pinnedObservationContexts:
              pinnedObservationContextsByTaskRunId[draft.taskRun.id] ?? [],
          });
        } catch (e) {
          noteAgentProgress(
            draft.taskRun.id,
            "cli",
            "에이전트 실행 실패",
            errorMessage(e),
          );
          // Surface but don't unwind — the placeholder TaskRun stays
          // around so the user can retry or fall back manually.
          // eslint-disable-next-line no-console
          console.error("agent.generatePlan failed", e);
        }
      }
      // Auto-draft orchestration plan when this message uses a pipeline,
      // a saved direct-harness binding set, OR the caller passed an
      // explicit legacy orchMode (still possible from the side
      // OrchestrationPanel).
      const effectiveOrchMode: OrchestrationMode | undefined = usingOrchestrationPick
        ? "single_worker"
        : input.orchMode;
      if (effectiveOrchMode) {
        try {
          const drafted = await window.harness.orchestration.draftPlan({
            taskRunId: draft.taskRun.id,
            mode: effectiveOrchMode,
            ...(input.orchInstruction
              ? { instruction: input.orchInstruction }
              : {}),
            ...(input.orchPipelineId
              ? { pipelineId: input.orchPipelineId }
              : {}),
            ...(input.orchHarness ? { harness: input.orchHarness } : {}),
          });
          // Picking a pipeline from ConversationInput IS the user's
          // approval — they explicitly chose to run this pipeline for
          // this message. Skip the extra "approve the plan?" friction
          // and run immediately. The orchestration_plan approval row
          // is still created (audit trail) and decideApproval marks it
          // executed via runApproved's tail. Legacy orchMode (no
          // pipeline) keeps the manual approval flow so the existing
          // OrchestrationPanel UX is unchanged.
          //
          // Pre-claim the approval id in autoInFlightRef so the global
          // auto-approve useEffect skips it — otherwise both paths can
          // race on the same id when `settings.approval.autoApprove`
          // is on, and the second runApproved fails with "approval is
          // executed". Always run for pipeline picks regardless of
          // global autoApprove: the user already opted in by selecting
          // a pipeline for this message.
          if (usingOrchestrationPick) {
            // The TaskRun was already marked pipeline-auto before
            // setSelectedTaskRunId (above) so AgentPanel could hide
            // the manual button on the very first render. Here we
            // just pre-claim the orchestration_plan approval id so
            // the global auto-approve useEffect doesn't race with
            // the explicit approve / runApproved call below.
            autoInFlightRef.current.add(drafted.approval.id);
            try {
              await window.harness.conversation.approve({
                approvalId: drafted.approval.id,
                message: "auto-approved (per-message pipeline pick)",
                autoApproveDecision: {
                  approved: true,
                  decidedAt: "global_toggle",
                  reason:
                    usingPipeline
                      ? "Pipeline plan was pre-approved by explicit per-message pipeline selection."
                      : "Harness plan was pre-approved by explicit per-message harness selection.",
                },
              });
              await window.harness.orchestration.runApproved({
                approvalId: drafted.approval.id,
              });
            } catch (e) {
              // Drop the claim so the global handler / a user retry can
              // pick it back up. Re-throw so ConversationInput's error
              // surface tells the user the auto-flow failed (instead of
              // silently leaving them looking at a "still working…"
              // placeholder while the task is actually stuck). The
              // user's recovery action is re-submitting the same
              // message: that creates a fresh TaskRun + plan +
              // approval and the auto-flow tries again on a clean
              // slate. Cleaner than wiring a retry button into the
              // orchestration panel that we've just hidden.
              autoInFlightRef.current.delete(drafted.approval.id);
              const message = e instanceof Error ? e.message : String(e);
              // eslint-disable-next-line no-console
              console.error(
                "auto-run after pipeline draftPlan failed",
                drafted.approval.id,
                e,
              );
              throw new Error(
                `${usingPipeline ? "파이프라인" : "Harness"} 자동 실행 실패 (${drafted.approval.id.slice(0, 8)}…): ${message}`,
              );
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("orchestration.draftPlan failed", e);
          if (usingOrchestrationPick) throw e;
        }
      }
      await refreshThreadDetail(selectedThreadId);
      if (selectedTaskRunId === draft.taskRun.id)
        await refreshTaskRunDetail(draft.taskRun.id);
    },
    [
      refreshThreadDetail,
      refreshTaskRunDetail,
      selectedTaskRunId,
      selectedThreadId,
      autoApprove,
      activeAgentProfile,
      noteAgentProgress,
      pinnedObservationContextsByTaskRunId,
    ],
  );

  useEffect(() => {
    if (!agentAvailable) return;
    if (taskRunDetail.kind !== "ready") return;
    const { taskRun, approvals, agentInvocations } = taskRunDetail.detail;
    if (taskRun.status !== "drafting") return;
    if (pipelineAutoTaskRunIdsRef.current.has(taskRun.id)) return;
    if (agentInvocations.length > 0) return;
    const advisoryApprovals = approvals.filter(
      (a) => a.actionType === "capability_use" || a.actionType === "model_use",
    );
    if (advisoryApprovals.length === 0) return;
    if (advisoryApprovals.some((a) => a.status === "pending")) return;
    const inFlight = advisoryResumeInFlightRef.current;
    if (inFlight.has(taskRun.id)) return;
    inFlight.add(taskRun.id);
    noteAgentProgress(
      taskRun.id,
      "context",
      "추천 후보 결정 완료",
      "승인/거절 결과를 반영해 Agent plan 생성을 시작합니다.",
    );
    void (async () => {
      try {
        await window.harness.agent.generatePlan({
          taskRunId: taskRun.id,
          pinnedObservationContexts:
            pinnedObservationContextsByTaskRunId[taskRun.id] ?? [],
        });
      } catch (e) {
        noteAgentProgress(
          taskRun.id,
          "cli",
          "에이전트 실행 실패",
          errorMessage(e),
        );
        inFlight.delete(taskRun.id);
      }
      await refreshTaskRunDetail(taskRun.id);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    })();
  }, [
    agentAvailable,
    noteAgentProgress,
    refreshTaskRunDetail,
    refreshThreadDetail,
    selectedThreadId,
    taskRunDetail,
    pinnedObservationContextsByTaskRunId,
  ]);

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
        const detail = await window.harness.conversation.getTaskRunDetail({
          taskRunId: selectedTaskRunId,
        });
        for (const approvalId of continuationOrchestrationApprovalIds(detail)) {
          await window.harness.orchestration.runApproved({ approvalId });
        }
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
  // approval events shouldn't keep re-opening it. Also skip entirely when
  // auto-approve is on — the user opted out of manual approval, so don't
  // disrupt their flow.
  const autoOpenedForTaskRunRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (autoApprove) return;
    if (!selectedTaskRunId) return;
    if (pendingApprovalCount === 0) return;
    if (autoOpenedForTaskRunRef.current.has(selectedTaskRunId)) return;
    autoOpenedForTaskRunRef.current.add(selectedTaskRunId);
    if (!contextDrawerOpen) setContextDrawerOpen(true);
  }, [pendingApprovalCount, contextDrawerOpen, selectedTaskRunId, autoApprove]);

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
      style={{
        // Grid columns: rail | thread drawer | main | context drawer
        gridTemplateColumns: `64px ${threadDrawerOpen ? `${sidebarWidth}px` : "0px"} 1fr ${contextDrawerOpen ? `${rightPanelWidth}px` : "0px"}`,
      }}
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

      {threadDrawerOpen && (
        <div
          className={`workbench-resizer${dragging === "sidebar" ? " workbench-resizer--dragging" : ""}`}
          style={{ left: 64 + sidebarWidth }}
          onMouseDown={handleSidebarResizerMouseDown}
        />
      )}
      {contextDrawerOpen && (
        <div
          className={`workbench-resizer${dragging === "right" ? " workbench-resizer--dragging" : ""}`}
          style={{ right: rightPanelWidth }}
          onMouseDown={handleRightResizerMouseDown}
        />
      )}

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
            />
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
