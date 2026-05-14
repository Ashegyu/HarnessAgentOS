import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentProfile,
  AgentProviderStatusMap,
  Approval,
  OrchestrationMode,
  ProposedActionDetails,
  Thread,
  ThreadDetail,
  TaskRunDetail,
} from "@harness/core";
import { shouldAutoApprove } from "@harness/core";
import { ThreadSidebar } from "./ThreadSidebar";
import { ConversationWorkbench } from "./ConversationWorkbench";
import type { ConversationMode } from "./ConversationInput";
import { RightPanel } from "./RightPanel";
import { RuntimeStatusBar } from "./RuntimeStatusBar";
import { SettingsPanel } from "./SettingsPanel";
import { SlimRail } from "./SlimRail";
import { HeroEmpty } from "./HeroEmpty";
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
  const [autoApprove, setAutoApprove] = useState(false);
  const [activeAgentProfile, setActiveAgentProfile] =
    useState<AgentProfile | null>(null);
  // Tracks approval IDs that the auto-approver has already kicked off so
  // the effect doesn't double-fire on the eventual taskRunChanged event
  // before the row's status flips out of "pending".
  const autoInFlightRef = useRef<Set<string>>(new Set());

  // Tracks TaskRun IDs that were created via pipeline-pick at submit
  // time. For these runs we auto-approve EVERY approval — the
  // orchestration_plan one AND any downstream worker-proposed approvals
  // (file_write, shell, …) — regardless of the global autoApprove flag
  // or the active profile's per-action permissions. Picking a pipeline
  // is itself the user's "yes, run everything this pipeline produces"
  // consent. Persisted to localStorage so an in-progress pipeline run
  // keeps auto-approving after a renderer reload.
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
        // Priority: settings modal > rightmost drawer
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
  }, [settingsOpen, contextDrawerOpen, threadDrawerOpen]);

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

  // Auto-approve + auto-execute. Combines three triggers:
  //   1. The global `approval.autoApprove` toggle.
  //   2. The active AgentProfile's per-action permissions.
  //   3. Pipeline-pick consent (this TaskRun was started by picking a
  //      pipeline in ConversationInput — every approval it produces is
  //      pre-approved, including downstream worker actions).
  //
  // The profile's BLOCK LIST is a hard floor across all three triggers
  // — a "trust everything" pipeline pick must NOT bypass an explicit
  // per-profile prohibition (e.g. a production profile that blocks
  // `git_commit`). Pipeline-pick consent only bypasses the global
  // toggle and the profile's per-action ALLOW list (those are
  // opt-ins); the block list is opt-out and stays authoritative.
  useEffect(() => {
    if (taskRunDetail.kind !== "ready") return;
    const inFlight = autoInFlightRef.current;
    const isPipelineAutoTask = pipelineAutoTaskRunIdsRef.current.has(
      taskRunDetail.detail.taskRun.id,
    );
    const blockedActions =
      activeAgentProfile?.permissions.blockedActions ?? [];
    const pending = taskRunDetail.detail.approvals.filter(
      (a: Approval): boolean => {
        if (a.status !== "pending") return false;
        if (inFlight.has(a.id)) return false;
        // Block list trumps every auto-approve trigger.
        if (blockedActions.includes(a.actionType)) return false;
        if (isPipelineAutoTask) return true;
        return shouldAutoApprove({
          approval: a,
          globalAutoApprove: autoApprove,
          activeProfile: activeAgentProfile,
        });
      },
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
    activeAgentProfile,
    taskRunDetail,
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
      orchMode?: OrchestrationMode;
      orchInstruction?: string;
      orchPipelineId?: string;
    }): Promise<void> => {
      if (!selectedThreadId) {
        throw new Error("스레드를 먼저 선택하세요");
      }
      // Routing is now per-message: whatever ConversationInput's
      // dropdown carries in `input.orchPipelineId` is what gets used.
      // `Thread.pipelineId` only seeds the dropdown's initial value
      // (so threads "remember" the user's last choice). The user
      // freely changes it for every submission.
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
      const usingPipeline =
        input.orchPipelineId !== undefined && input.orchPipelineId.length > 0;
      // Mark this TaskRun as pipeline-auto BEFORE the render that
      // mounts the detail panels. There's a race window between the
      // setSelectedTaskRunId → first taskRunDetail fetch and the
      // orchestration.draftPlan call below: if we only mark inside
      // the draftPlan branch, the first render of AgentPanel sees
      // no orchestration_plan approval and would show the "Agent
      // plan 생성" button. Pre-marking lets RightPanel pass
      // `pipelineAutoLaunched` through to AgentPanel on the very
      // first render so the manual button never flashes.
      if (usingPipeline) markPipelineAutoTaskRun(draft.taskRun.id);
      setSelectedTaskRunId(draft.taskRun.id);
      // Agent mode: chain into generatePlan immediately so the user
      // sees streaming output instead of a sitting-still placeholder.
      // Skipped when the message routes through a pipeline —
      // orchestration owns the response generation in that case.
      if (input.mode === "agent" && !usingPipeline) {
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
      // Auto-draft orchestration plan when this message uses a
      // pipeline OR the caller passed an explicit legacy orchMode
      // (still possible from the side OrchestrationPanel).
      const effectiveOrchMode: OrchestrationMode | undefined = usingPipeline
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
          if (usingPipeline) {
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
                `파이프라인 자동 실행 실패 (${drafted.approval.id.slice(0, 8)}…): ${message}`,
              );
            }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("orchestration.draftPlan failed", e);
          if (usingPipeline) throw e;
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
        hasSelectedTaskRun={hasSelectedTaskRun}
        theme={theme}
        onToggleThreadDrawer={toggleThreadDrawer}
        onToggleContextDrawer={toggleContextDrawer}
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
              onCapabilityApprovalCreated={handleQualityChanged}
              onAgentGenerate={handleAgentGenerate}
              onAgentRetry={handleAgentRetry}
              onAgentCancel={handleAgentCancel}
              onAgentUseFallback={handleAgentUseFallback}
              agentAvailable={agentAvailable}
              pipelineAutoLaunched={
                selectedTaskRunId !== null &&
                pipelineAutoTaskRunIdsRef.current.has(selectedTaskRunId)
              }
            />
          </aside>
        </>
      <RuntimeStatusBar />
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
