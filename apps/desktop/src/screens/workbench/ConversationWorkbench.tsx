import { useEffect, useRef, useState } from "react";
import type {
  AgentInvocation,
  Approval,
  TaskRun,
  ThreadDetail,
} from "@harness/core";
import { ConversationInput, type ConversationMode } from "./ConversationInput";
import { TaskRunStatusBadge } from "./TaskRunStatusBadge";
import { HeroEmpty } from "./HeroEmpty";
import { InlineApprovalCard } from "./InlineApprovalCard";
import { InlineAgentStream } from "./InlineAgentStream";
import {
  AgentProgressList,
  type AgentProgressItem,
} from "./AgentProgressList";

type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; threadId: string }
  | { kind: "ready"; detail: ThreadDetail }
  | { kind: "error"; threadId: string; message: string };

interface ConversationWorkbenchProps {
  detailState: DetailState;
  selectedTaskRunId: string | null;
  onSelectTaskRun: (id: string) => void;
  onDeleteTask: (id: string) => Promise<void>;
  onCreateTask: (input: {
    userRequest: string;
    targetDir?: string;
    mode: ConversationMode;
  }) => Promise<void>;
  threadTargetDir: string | undefined;
  threadId: string | null;
  /**
   * AgentPipeline.id bound to the currently selected thread. When set,
   * ConversationInput hides the per-message Orchestration toggle and
   * shows a "Pipeline: <name>" badge instead.
   */
  threadPipelineId: string | undefined;
  agentAvailable: boolean;
  contextDrawerOpen: boolean;
  onToggleContextDrawer: () => void;
  pendingApprovalCount: number;
  autoApprove: boolean;
  onOpenThreadDrawer?: () => void;
  activeTaskRunApprovals: Approval[];
  activeTaskRunId: string | null;
  /**
   * AgentInvocations for the currently-selected TaskRun. Used to render
   * the central-window streaming view inline next to its ChatTurn. Empty
   * when no run is selected or the run hasn't produced any invocation
   * yet (e.g. before the user clicks 「Generate plan」 in agent mode and
   * before the worker step starts in pipeline mode).
   */
  activeTaskRunInvocations: AgentInvocation[];
  agentProgressByTaskRunId: Record<string, AgentProgressItem[]>;
}

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const ConversationWorkbench = ({
  detailState,
  selectedTaskRunId,
  onSelectTaskRun,
  onDeleteTask,
  onCreateTask,
  threadTargetDir,
  threadId,
  threadPipelineId,
  agentAvailable,
  contextDrawerOpen,
  onToggleContextDrawer,
  pendingApprovalCount,
  autoApprove,
  onOpenThreadDrawer,
  activeTaskRunApprovals,
  activeTaskRunId,
  activeTaskRunInvocations,
  agentProgressByTaskRunId,
}: ConversationWorkbenchProps): JSX.Element => {
  const [composerSeed, setComposerSeed] = useState<
    { text: string; key: number } | null
  >(null);
  const seedFromChip = (text: string): void => {
    setComposerSeed({ text, key: Date.now() });
  };

  if (detailState.kind === "idle") {
    return (
      <main className="conversation-workbench" aria-label="Conversation workbench">
        <HeroEmpty
          variant="no-thread-selected"
          {...(onOpenThreadDrawer ? { onOpenDrawer: onOpenThreadDrawer } : {})}
        />
      </main>
    );
  }

  if (detailState.kind === "loading") {
    return (
      <main className="conversation-workbench" aria-label="Conversation workbench">
        <header className="panel-header">
          <span>Workbench</span>
          <span style={{ color: "var(--text-muted)" }}>불러오는 중…</span>
        </header>
        <div className="conversation-workbench__greeting">
          <p>스레드 정보 불러오는 중…</p>
        </div>
      </main>
    );
  }

  if (detailState.kind === "error") {
    return (
      <main className="conversation-workbench" aria-label="Conversation workbench">
        <header className="panel-header">
          <span>Workbench</span>
          <span style={{ color: "var(--status-failed)" }}>오류</span>
        </header>
        <div className="conversation-workbench__greeting">
          <h1>스레드를 불러오지 못했습니다</h1>
          <code style={{ color: "var(--status-failed)" }}>
            {detailState.message}
          </code>
        </div>
      </main>
    );
  }

  return (
    <main className="conversation-workbench" aria-label="Conversation workbench">
      <ChatHeader
        thread={detailState.detail.thread}
        contextDrawerOpen={contextDrawerOpen}
        onToggleContextDrawer={onToggleContextDrawer}
        pendingApprovalCount={pendingApprovalCount}
        autoApprove={autoApprove}
      />
      <ChatTranscript
        detail={detailState.detail}
        selectedTaskRunId={selectedTaskRunId}
        onSelectTaskRun={onSelectTaskRun}
        onDeleteTask={onDeleteTask}
        onSuggest={seedFromChip}
        activeTaskRunId={activeTaskRunId}
        activeTaskRunApprovals={activeTaskRunApprovals}
        activeTaskRunInvocations={activeTaskRunInvocations}
        agentProgressByTaskRunId={agentProgressByTaskRunId}
        autoApprove={autoApprove}
        contextDrawerOpen={contextDrawerOpen}
        onOpenContextDrawer={() => {
          if (!contextDrawerOpen) onToggleContextDrawer();
        }}
      />
      <ConversationInput
        threadId={threadId}
        threadTargetDir={threadTargetDir}
        threadPipelineId={threadPipelineId}
        agentAvailable={agentAvailable}
        composerSeed={composerSeed}
        onSubmit={onCreateTask}
      />
    </main>
  );
};

const ChatHeader = ({
  thread,
  contextDrawerOpen,
  onToggleContextDrawer,
  pendingApprovalCount,
  autoApprove,
}: {
  thread: ThreadDetail["thread"];
  contextDrawerOpen: boolean;
  onToggleContextDrawer: () => void;
  pendingApprovalCount: number;
  autoApprove: boolean;
}) => (
  <header className="panel-header chat-header">
    <span className="chat-header__title">{thread.title}</span>
    <span
      className="chat-header__targetdir"
      title={thread.targetDir ?? "대상 폴더 미선택"}
    >
      {thread.targetDir ?? "대상 폴더 미선택"}
    </span>
    <button
      type="button"
      className={`chat-header__drawer-btn${contextDrawerOpen ? " chat-header__drawer-btn--active" : ""}`}
      onClick={onToggleContextDrawer}
      aria-pressed={contextDrawerOpen}
      aria-label={contextDrawerOpen ? "컨텍스트 패널 닫기" : "컨텍스트 패널 열기"}
      title={contextDrawerOpen ? "컨텍스트 닫기 (Ctrl+J)" : "컨텍스트 열기 (Ctrl+J)"}
    >
      <span aria-hidden>▦</span>
      {pendingApprovalCount > 0 && (
        <span
          className={`chat-header__badge${autoApprove ? " chat-header__badge--auto" : ""}`}
          aria-label={
            autoApprove
              ? `${pendingApprovalCount}건 자동 승인 처리 중`
              : `${pendingApprovalCount}건의 승인 대기`
          }
        >
          {pendingApprovalCount}
        </span>
      )}
    </button>
  </header>
);

const ChatTranscript = ({
  detail,
  selectedTaskRunId,
  onSelectTaskRun,
  onDeleteTask,
  onSuggest,
  activeTaskRunId,
  activeTaskRunApprovals,
  activeTaskRunInvocations,
  agentProgressByTaskRunId,
  autoApprove,
  contextDrawerOpen,
  onOpenContextDrawer,
}: {
  detail: ThreadDetail;
  selectedTaskRunId: string | null;
  onSelectTaskRun: (id: string) => void;
  onDeleteTask: (id: string) => Promise<void>;
  onSuggest: (text: string) => void;
  activeTaskRunId: string | null;
  activeTaskRunApprovals: Approval[];
  activeTaskRunInvocations: AgentInvocation[];
  agentProgressByTaskRunId: Record<string, AgentProgressItem[]>;
  autoApprove: boolean;
  contextDrawerOpen: boolean;
  onOpenContextDrawer: () => void;
}): JSX.Element => {
  const { taskRuns, agentAnswers } = detail;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Sort oldest-first so the transcript reads top-down like a chat log.
  const ordered = [...taskRuns].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  // Latest invocation for the currently-active TaskRun — used to attach
  // an inline streaming view to that turn's agent bubble. Sorted oldest
  // first, so the last entry is the most recent.
  const latestInvocation: AgentInvocation | undefined =
    activeTaskRunInvocations.length > 0
      ? activeTaskRunInvocations.reduce(
          (acc, curr) =>
            new Date(curr.createdAt).getTime() > new Date(acc.createdAt).getTime()
              ? curr
              : acc,
          activeTaskRunInvocations[0] as AgentInvocation,
        )
      : undefined;

  // Auto-scroll to latest message whenever the message count changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [ordered.length, selectedTaskRunId]);

  // Also re-anchor when a new invocation starts streaming, so users
  // don't miss the first tokens.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [latestInvocation?.id]);

  if (ordered.length === 0) {
    return (
      <div className="chat-transcript" ref={scrollRef}>
        <HeroEmpty variant="no-tasks" onSuggest={onSuggest} />
      </div>
    );
  }

  return (
    <div className="chat-transcript" ref={scrollRef}>
      {ordered.map((tr) => (
        <ChatTurn
          key={tr.id}
          taskRun={tr}
          answer={agentAnswers?.[tr.id]}
          isSelected={selectedTaskRunId === tr.id}
          onSelect={() => onSelectTaskRun(tr.id)}
          onDelete={() => void onDeleteTask(tr.id)}
          invocation={
            activeTaskRunId === tr.id ? latestInvocation : undefined
          }
          progress={agentProgressByTaskRunId[tr.id] ?? []}
          inlineApprovalCard={
            activeTaskRunId === tr.id ? (
              <InlineApprovalCard
                approvals={activeTaskRunApprovals}
                autoApprove={autoApprove}
                contextDrawerOpen={contextDrawerOpen}
                onOpenDrawer={onOpenContextDrawer}
              />
            ) : null
          }
        />
      ))}
    </div>
  );
};

const ChatTurn = ({
  taskRun,
  answer,
  isSelected,
  onSelect,
  onDelete,
  invocation,
  progress,
  inlineApprovalCard,
}: {
  taskRun: TaskRun;
  answer: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  invocation: AgentInvocation | undefined;
  progress: readonly AgentProgressItem[];
  inlineApprovalCard: JSX.Element | null;
}): JSX.Element => {
  // When this turn has a live invocation we render the streaming view
  // INSIDE the agent bubble's body. This keeps the chat-turn structure
  // intact (one user bubble + one agent bubble + inline approval card)
  // and lets the stream sections own their own scroll without breaking
  // the parent transcript scroll. We still surface the final answer
  // separately so the chat reads like a chat once streaming completes.
  const hasInvocation = invocation !== undefined;
  const hasFinalAnswer = answer !== undefined && answer.length > 0;

  return (
    <div
      className={`chat-turn${isSelected ? " chat-turn--selected" : ""}`}
      onClick={onSelect}
    >
      <div className="chat-bubble chat-bubble--user">
        <div className="chat-bubble__body">{taskRun.userRequest}</div>
        <div className="chat-bubble__meta">
          <span>{formatTime(taskRun.createdAt)}</span>
          <button
            type="button"
            className="chat-bubble__delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="대화 삭제"
            title="이 메시지/작업 삭제"
          >
            ×
          </button>
        </div>
      </div>

      <div className="chat-bubble chat-bubble--agent">
        <div className="chat-bubble__body">
          {hasInvocation ? (
            // The stream view's 최종 답변 section IS the response once
            // streaming completes. We deliberately do NOT also render the
            // `agentAnswers[tr.id]` plan summary below it — that surface
            // lives in the right panel's Plan tab, so duplicating it
            // here would just confuse "which one is canonical?".
            <InlineAgentStream invocation={invocation} />
          ) : progress.length > 0 && !hasFinalAnswer ? (
            <AgentProgressList items={progress} compact />
          ) : hasFinalAnswer ? (
            // No live invocation on this turn (older turn, or backend
            // didn't go through the agent path) — fall back to the
            // persisted plan-summary text so the bubble isn't empty.
            <ChatBubbleAnswer text={answer} />
          ) : (
            <span className="chat-bubble__pending">
              {pendingPlaceholder(taskRun.status)}
            </span>
          )}
        </div>
        <div className="chat-bubble__meta">
          <TaskRunStatusBadge status={taskRun.status} />
          <span title={taskRun.targetDir}>{shortPath(taskRun.targetDir)}</span>
        </div>
      </div>
      {inlineApprovalCard}
    </div>
  );
};

// Plan summaries are markdown but rendering full markdown is overkill —
// preserve line breaks and clip overly long bodies with a "더 보기" toggle.
const ChatBubbleAnswer = ({ text }: { text: string }): JSX.Element => {
  const LIMIT = 1200;
  const tooLong = text.length > LIMIT;
  return tooLong ? (
    <details>
      <summary className="chat-bubble__more">
        {text.slice(0, LIMIT)}…{" "}
        <span className="chat-bubble__more-cta">더 보기</span>
      </summary>
      <pre className="chat-bubble__full">{text}</pre>
    </details>
  ) : (
    <pre className="chat-bubble__full">{text}</pre>
  );
};

const pendingPlaceholder = (status: TaskRun["status"]): string => {
  switch (status) {
    case "drafting":
      return "응답 준비 중…";
    case "running":
      return "Agent 응답 중…";
    case "blocked":
      return "응답 실패 — 우측 패널에서 재시도/Fallback 확인";
    case "cancelled":
      return "취소됨";
    case "waiting_for_approval":
      return "응답 도착 — 우측 패널에서 승인 확인";
    case "ready_for_review":
      return "응답 도착 — 우측 패널에서 확인";
    default:
      return "(응답 없음)";
  }
};

const shortPath = (p: string): string => {
  if (p.length <= 36) return p;
  return `${p.slice(0, 12)}…${p.slice(-20)}`;
};
