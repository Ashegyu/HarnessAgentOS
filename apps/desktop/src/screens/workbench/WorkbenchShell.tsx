import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentProviderStatusMap,
  Approval,
  OrchestrationMode,
  ProposedActionDetails,
  Thread,
  ThreadDetail,
  TaskRunDetail,
} from "@harness/core";
import { ThreadSidebar } from "./ThreadSidebar";
import { ConversationWorkbench } from "./ConversationWorkbench";
import type { ConversationMode } from "./ConversationInput";
import { RightPanel } from "./RightPanel";
import { RuntimeStatusBar } from "./RuntimeStatusBar";
import { SettingsPanel } from "./SettingsPanel";
import { AgentsPanel } from "./AgentsPanel";
import "./workbench.css";

type ThreadsState =
  | { kind: "loading" }
  | { kind: "ready"; threads: Thread[] }
  | { kind: "error"; message: string };

type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; threadId: string }
  | { kind: "ready"; detail: ThreadDetail }
  | { kind: "error"; threadId: string; message: string };

type TaskRunDetailState =
  | { kind: "idle" }
  | { kind: "loading"; taskRunId: string }
  | { kind: "ready"; detail: TaskRunDetail }
  | { kind: "error"; taskRunId: string; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

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
  const [viewMode, setViewMode] = useState<"workbench" | "agents">("workbench");
  const [autoApprove, setAutoApprove] = useState(false);
  // Tracks approval IDs that the auto-approver has already kicked off so
  // the effect doesn't double-fire on the eventual taskRunChanged event
  // before the row's status flips out of "pending".
  const autoInFlightRef = useRef<Set<string>>(new Set());

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
    return saved ? Math.max(180, Math.min(400, Number(saved))) : 240;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const saved = localStorage.getItem("workbench-right-width");
    return saved ? Math.max(280, Math.min(600, Number(saved))) : 360;
  });
  const [dragging, setDragging] = useState<"sidebar" | "right" | null>(null);

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
      setDetailState({ kind: "loading", threadId });
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

  const refreshTaskRunDetail = useCallback(async (taskRunId: string) => {
    setTaskRunDetail({ kind: "loading", taskRunId });
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
    } catch {
      setAutoApprove(false);
    }
  }, []);

  useEffect(() => {
    void refreshAutoApprove();
  }, [refreshAutoApprove]);

  useEffect(() => {
    void refreshProviders();
    const off = window.harness.events.onAgentStreamEvent((event) => {
      if (
        event.type === "started" ||
        event.type === "result" ||
        event.type === "failed"
      ) {
        void refreshProviders();
      }
    });
    return off;
  }, [refreshProviders]);

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

  // Auto-approve + auto-execute. When the user opts in via settings, the
  // renderer transparently approves every pending approval and runs it,
  // including high-risk action types and orchestration plans. The
  // service-layer security gate is untouched — this is UI-level only.
  useEffect(() => {
    if (!autoApprove) return;
    if (taskRunDetail.kind !== "ready") return;
    const inFlight = autoInFlightRef.current;
    const pending = taskRunDetail.detail.approvals.filter(
      (a: Approval): boolean => a.status === "pending" && !inFlight.has(a.id),
    );
    if (pending.length === 0) return;
    void (async () => {
      for (const approval of pending) {
        inFlight.add(approval.id);
        try {
          await window.harness.conversation.approve({
            approvalId: approval.id,
            message: "auto-approved (settings.approval.autoApprove)",
          });
          if (approval.actionType === "orchestration_plan") {
            await window.harness.orchestration.runApproved({
              approvalId: approval.id,
            });
          } else {
            await window.harness.runner.executeApproved({
              approvalId: approval.id,
            });
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("auto-approve failed", approval.id, e);
          // Drop from in-flight so a future refresh can retry rather than
          // silently leaving the approval stuck in "approved but not run".
          inFlight.delete(approval.id);
        }
      }
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
      if (selectedThreadId) await refreshThreadDetail(selectedThreadId);
    })();
  }, [
    autoApprove,
    taskRunDetail,
    selectedTaskRunId,
    selectedThreadId,
    refreshTaskRunDetail,
    refreshThreadDetail,
  ]);

  const handleCreateThread = useCallback(
    async (input: { title: string; targetDir?: string }): Promise<void> => {
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
      orchMode?: OrchestrationMode;
      orchInstruction?: string;
    }): Promise<void> => {
      if (!selectedThreadId) {
        throw new Error("스레드를 먼저 선택하세요");
      }
      const payload: {
        threadId: string;
        userRequest: string;
        targetDir?: string;
        mode: ConversationMode;
      } = {
        threadId: selectedThreadId,
        userRequest: input.userRequest,
        mode: input.mode,
      };
      if (input.targetDir !== undefined) payload.targetDir = input.targetDir;
      const draft = await window.harness.conversation.createTask(payload);
      setSelectedTaskRunId(draft.taskRun.id);
      // Agent mode: chain into generatePlan immediately so the user sees
      // streaming output instead of a sitting-still placeholder.
      if (input.mode === "agent") {
        try {
          await window.harness.agent.generatePlan({
            taskRunId: draft.taskRun.id,
          });
        } catch (e) {
          // Surface but don't unwind — the placeholder TaskRun stays
          // around so the user can retry or fall back manually.
          // eslint-disable-next-line no-console
          console.error("agent.generatePlan failed", e);
        }
      }
      // Auto-draft orchestration plan when the user configured it upfront.
      if (input.orchMode) {
        try {
          await window.harness.orchestration.draftPlan({
            taskRunId: draft.taskRun.id,
            mode: input.orchMode,
            ...(input.orchInstruction ? { instruction: input.orchInstruction } : {}),
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("orchestration.draftPlan failed", e);
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
    ],
  );

  const handleAgentGenerate = useCallback(
    async (taskRunId: string): Promise<void> => {
      await window.harness.agent.generatePlan({ taskRunId });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [refreshTaskRunDetail, selectedTaskRunId],
  );

  const handleAgentRetry = useCallback(
    async (invocationId: string): Promise<void> => {
      await window.harness.agent.retryInvocation({ invocationId });
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
    },
    [refreshTaskRunDetail, selectedTaskRunId],
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
      if (selectedTaskRunId) await refreshTaskRunDetail(selectedTaskRunId);
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

  return (
    <div
      className="workbench"
      style={{ gridTemplateColumns: `${sidebarWidth}px 1fr ${rightPanelWidth}px` }}
    >
      <div
        className={`workbench-resizer${dragging === "sidebar" ? " workbench-resizer--dragging" : ""}`}
        style={{ left: sidebarWidth }}
        onMouseDown={handleSidebarResizerMouseDown}
      />
      {viewMode !== "agents" && (
        <div
          className={`workbench-resizer${dragging === "right" ? " workbench-resizer--dragging" : ""}`}
          style={{ right: rightPanelWidth }}
          onMouseDown={handleRightResizerMouseDown}
        />
      )}
      <ThreadSidebar
        state={threadsState}
        selectedThreadId={selectedThreadId}
        onSelectThread={(id) => {
          setSelectedThreadId(id);
          setSelectedTaskRunId(null);
          setViewMode("workbench");
        }}
        onCreateThread={handleCreateThread}
        onDeleteThread={handleDeleteThread}
        onRetry={() => void refreshThreads()}
        onOpenAgents={() => setViewMode((v) => v === "agents" ? "workbench" : "agents")}
        agentsActive={viewMode === "agents"}
      />
      {viewMode === "agents" ? (
        <AgentsPanel onClose={() => setViewMode("workbench")} />
      ) : (
        <>
          <ConversationWorkbench
            detailState={detailState}
            selectedTaskRunId={selectedTaskRunId}
            onSelectTaskRun={setSelectedTaskRunId}
            onDeleteTask={handleDeleteTask}
            onCreateTask={handleCreateTask}
            threadTargetDir={selectedThread?.targetDir}
            threadId={selectedThreadId}
            agentAvailable={agentAvailable}
          />
          <RightPanel
            state={taskRunDetail}
            onApprove={handleApprove}
            onReject={handleReject}
            onRedirect={handleRedirect}
            onConfigure={handleConfigure}
            onExecute={handleExecute}
            onQualityChanged={handleQualityChanged}
            onCapabilityApprovalCreated={handleQualityChanged}
            onAgentGenerate={handleAgentGenerate}
            onAgentRetry={handleAgentRetry}
            onAgentCancel={handleAgentCancel}
            onAgentUseFallback={handleAgentUseFallback}
            agentAvailable={agentAvailable}
          />
        </>
      )}
      <RuntimeStatusBar
        onSettingsClick={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />
      {settingsOpen && (
        <SettingsPanel
          onClose={() => {
            setSettingsOpen(false);
            void refreshAutoApprove();
          }}
        />
      )}
    </div>
  );
};
