import { useCallback, useEffect, useState } from "react";
import type {
  ProposedActionDetails,
  Thread,
  ThreadDetail,
  TaskRunDetail,
} from "@harness/core";
import { ThreadSidebar } from "./ThreadSidebar";
import { ConversationWorkbench } from "./ConversationWorkbench";
import { RightPanel } from "./RightPanel";
import { RuntimeStatusBar } from "./RuntimeStatusBar";
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
    }): Promise<void> => {
      if (!selectedThreadId) {
        throw new Error("스레드를 먼저 선택하세요");
      }
      const payload: {
        threadId: string;
        userRequest: string;
        targetDir?: string;
      } = {
        threadId: selectedThreadId,
        userRequest: input.userRequest,
      };
      if (input.targetDir !== undefined) payload.targetDir = input.targetDir;
      const draft = await window.harness.conversation.createTask(payload);
      await refreshThreadDetail(selectedThreadId);
      setSelectedTaskRunId(draft.taskRun.id);
    },
    [refreshThreadDetail, selectedThreadId],
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
    <div className="workbench">
      <ThreadSidebar
        state={threadsState}
        selectedThreadId={selectedThreadId}
        onSelectThread={(id) => {
          setSelectedThreadId(id);
          setSelectedTaskRunId(null);
        }}
        onCreateThread={handleCreateThread}
        onRetry={() => void refreshThreads()}
      />
      <ConversationWorkbench
        detailState={detailState}
        selectedTaskRunId={selectedTaskRunId}
        onSelectTaskRun={setSelectedTaskRunId}
        onCreateTask={handleCreateTask}
        threadTargetDir={selectedThread?.targetDir}
        threadId={selectedThreadId}
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
      />
      <RuntimeStatusBar />
    </div>
  );
};
