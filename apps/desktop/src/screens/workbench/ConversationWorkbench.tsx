import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentInvocation,
  Approval,
  TaskRun,
  ThreadDetail,
  Step,
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
import {
  hydrateSavedAgentOutput,
  initStreamParserState,
} from "./agent-stream-parser";
import { AgentStreamSections } from "./AgentStreamSections";
import { stripEmbeddedOrchestrationPlanJson } from "./orchestration-plan-display";
import {
  deriveChatTurnStatusBadge,
  taskRunWithActiveOverride,
} from "./chat-turn-status";
import {
  describeAgentInvocationForDisplay,
  orderedAgentInvocationsForDisplay,
} from "./agent-invocation-display";

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
    followUpTaskRunId?: string;
    orchMode?: import("@harness/core").OrchestrationMode;
    orchInstruction?: string;
    orchPipelineId?: string;
    orchHarness?: {
      packageId: string;
      workflowId?: string;
      bindingSetId: string;
    };
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
  activeTaskRun: TaskRun | null;
  activeTaskRunSteps: Step[];
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

interface FollowUpTaskRunOption {
  id: string;
  ordinal: number;
  userRequest: string;
}

const resolveFollowUpTaskRun = (
  taskRuns: readonly TaskRun[],
  selectedTaskRunId: string | null,
): FollowUpTaskRunOption | null => {
  if (taskRuns.length === 0) return null;
  const ordered = [...taskRuns].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id.localeCompare(b.id),
  );
  const selectedIndex =
    selectedTaskRunId === null
      ? -1
      : ordered.findIndex((taskRun) => taskRun.id === selectedTaskRunId);
  const index = selectedIndex >= 0 ? selectedIndex : ordered.length - 1;
  const taskRun = ordered[index];
  if (!taskRun) return null;
  return {
    id: taskRun.id,
    ordinal: index + 1,
    userRequest: taskRun.userRequest,
  };
};

interface ChatTurnThreadLink {
  ordinal: number;
  total: number;
  previous?: TaskRun;
  next?: TaskRun;
  onSelectTaskRun: (id: string) => void;
}

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
  activeTaskRun,
  activeTaskRunSteps,
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

  const followUpTaskRun = resolveFollowUpTaskRun(
    detailState.detail.taskRuns,
    selectedTaskRunId,
  );

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
        activeTaskRun={activeTaskRun}
        activeTaskRunSteps={activeTaskRunSteps}
      />
      <ConversationInput
        threadId={threadId}
        threadTargetDir={threadTargetDir}
        threadPipelineId={threadPipelineId}
        agentAvailable={agentAvailable}
        composerSeed={composerSeed}
        followUpTaskRun={followUpTaskRun}
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
  activeTaskRun,
  activeTaskRunSteps,
}: {
  detail: ThreadDetail;
  selectedTaskRunId: string | null;
  onSelectTaskRun: (id: string) => void;
  onDeleteTask: (id: string) => Promise<void>;
  onSuggest: (text: string) => void;
  activeTaskRunId: string | null;
  activeTaskRun: TaskRun | null;
  activeTaskRunSteps: Step[];
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

  const displayInvocations = useMemo(
    () => orderedAgentInvocationsForDisplay(activeTaskRunInvocations),
    [activeTaskRunInvocations],
  );
  const latestInvocation = displayInvocations[displayInvocations.length - 1];

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
      <ThreadTaskFlow
        taskRuns={ordered}
        selectedTaskRunId={selectedTaskRunId}
        agentAnswers={agentAnswers ?? {}}
        onSelectTaskRun={onSelectTaskRun}
      />
      {ordered.map((tr, index) => {
        const displayTaskRun = taskRunWithActiveOverride(tr, activeTaskRun);
        const isActive = activeTaskRunId === tr.id;
        return (
          <ChatTurn
            key={tr.id}
            taskRun={displayTaskRun}
            answer={agentAnswers?.[tr.id]}
            isSelected={selectedTaskRunId === tr.id}
            onSelect={() => onSelectTaskRun(tr.id)}
            onDelete={() => void onDeleteTask(tr.id)}
            invocations={isActive ? displayInvocations : []}
            steps={isActive ? activeTaskRunSteps : []}
            approvals={isActive ? activeTaskRunApprovals : []}
            progress={agentProgressByTaskRunId[tr.id] ?? []}
            threadLink={{
              ordinal: index + 1,
              total: ordered.length,
              ...(ordered[index - 1]
                ? { previous: ordered[index - 1] }
                : {}),
              ...(ordered[index + 1] ? { next: ordered[index + 1] } : {}),
              onSelectTaskRun,
            }}
            inlineApprovalCard={
              isActive ? (
                <InlineApprovalCard
                  approvals={activeTaskRunApprovals}
                  autoApprove={autoApprove}
                  contextDrawerOpen={contextDrawerOpen}
                  onOpenDrawer={onOpenContextDrawer}
                />
              ) : null
            }
          />
        );
      })}
    </div>
  );
};

const ThreadTaskFlow = ({
  taskRuns,
  selectedTaskRunId,
  agentAnswers,
  onSelectTaskRun,
}: {
  taskRuns: readonly TaskRun[];
  selectedTaskRunId: string | null;
  agentAnswers: Record<string, string>;
  onSelectTaskRun: (id: string) => void;
}): JSX.Element | null => {
  if (taskRuns.length <= 1) return null;
  return (
    <nav className="thread-task-flow" aria-label="Current thread TaskRun flow">
      <header className="thread-task-flow__header">
        <span>Thread Task Flow</span>
        <strong>{taskRuns.length} tasks connected</strong>
      </header>
      <ol className="thread-task-flow__nodes">
        {taskRuns.map((taskRun, index) => {
          const selected = selectedTaskRunId === taskRun.id;
          const hasAnswer = (agentAnswers[taskRun.id]?.length ?? 0) > 0;
          return (
            <li key={taskRun.id} className="thread-task-flow__item">
              <button
                type="button"
                className={`thread-task-flow__node${
                  selected ? " thread-task-flow__node--selected" : ""
                }`}
                onClick={() => onSelectTaskRun(taskRun.id)}
                aria-current={selected ? "step" : undefined}
                title={taskRun.userRequest}
              >
                <span className="thread-task-flow__ordinal">
                  Task {index + 1}
                </span>
                <TaskRunStatusBadge status={taskRun.status} />
                <strong>{shortTaskText(taskRun.userRequest, 54)}</strong>
                <span>{hasAnswer ? "답변 있음" : "답변 대기"}</span>
              </button>
              {index < taskRuns.length - 1 ? (
                <span className="thread-task-flow__connector" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

const ChatTurn = ({
  taskRun,
  answer,
  isSelected,
  onSelect,
  onDelete,
  invocations,
  steps,
  approvals,
  progress,
  threadLink,
  inlineApprovalCard,
}: {
  taskRun: TaskRun;
  answer: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  invocations: readonly AgentInvocation[];
  steps: readonly Step[];
  approvals: readonly Approval[];
  progress: readonly AgentProgressItem[];
  threadLink: ChatTurnThreadLink;
  inlineApprovalCard: JSX.Element | null;
}): JSX.Element => {
  // When this turn has a live invocation we render the streaming view
  // INSIDE the agent bubble's body. This keeps the chat-turn structure
  // intact (one user bubble + one agent bubble + inline approval card)
  // and lets the stream sections own their own scroll without breaking
  // the parent transcript scroll.
  const displayInvocations = useMemo(
    () => orderedAgentInvocationsForDisplay(invocations),
    [invocations],
  );
  const latestInvocation =
    displayInvocations.length > 0
      ? displayInvocations[displayInvocations.length - 1]
      : undefined;
  const hasInvocation = displayInvocations.length > 0;
  const hasFinalAnswer = answer !== undefined && answer.length > 0;
  const statusBadge = deriveChatTurnStatusBadge({
    taskRunStatus: taskRun.status,
    invocationStatus: latestInvocation?.status,
    approvals,
    hasFinalAnswer,
  });

  return (
    <div
      className={`chat-turn${isSelected ? " chat-turn--selected" : ""}`}
      onClick={onSelect}
    >
      {threadLink.total > 1 ? (
        <div className="chat-turn__thread-link" aria-label="Thread task links">
          <span>
            Task {threadLink.ordinal} / {threadLink.total}
          </span>
          {threadLink.previous ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                threadLink.onSelectTaskRun(threadLink.previous!.id);
              }}
              title={threadLink.previous.userRequest}
            >
              이전 태스크
            </button>
          ) : null}
          {threadLink.next ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                threadLink.onSelectTaskRun(threadLink.next!.id);
              }}
              title={threadLink.next.userRequest}
            >
              다음 태스크
            </button>
          ) : null}
        </div>
      ) : null}
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
            <div className="inline-agent-stream-stack">
              {displayInvocations.map((invocation, index) => (
                <section
                  key={invocation.id}
                  className="inline-agent-stream-stack__item"
                  aria-label={`Agent invocation ${index + 1}`}
                >
                  <AgentAnswerLabel
                    invocation={invocation}
                    steps={steps}
                    ordinal={index + 1}
                  />
                  <InlineAgentStream invocation={invocation} />
                </section>
              ))}
            </div>
          ) : progress.length > 0 && !hasFinalAnswer ? (
            <AgentProgressList items={progress} compact />
          ) : hasFinalAnswer ? (
            // No live invocation on this turn (older turn, or backend
            // didn't go through the agent path) — fall back to the
            // persisted agent output so completed runs keep the same
            // sectioned shape as the live stream.
            <ChatBubbleAnswer text={answer} />
          ) : (
            <span className="chat-bubble__pending">
              {pendingPlaceholder(taskRun.status)}
            </span>
          )}
        </div>
        <div className="chat-bubble__meta">
          <TaskRunStatusBadge
            status={statusBadge.status}
            label={statusBadge.label}
            kind={statusBadge.kind}
          />
          <span title={taskRun.targetDir}>{shortPath(taskRun.targetDir)}</span>
        </div>
      </div>
      {inlineApprovalCard}
    </div>
  );
};

const AgentAnswerLabel = ({
  invocation,
  steps,
  ordinal,
}: {
  invocation: AgentInvocation;
  steps: readonly Step[];
  ordinal: number;
}): JSX.Element => {
  const display = describeAgentInvocationForDisplay(invocation, steps);
  return (
    <header className="agent-answer-label">
      <div className="agent-answer-label__main">
        <span className="agent-answer-label__caption">Agent {ordinal}</span>
        <strong>{display.agentName}</strong>
        <code>{display.providerLabel}</code>
      </div>
      <span className="agent-answer-label__detail" title={display.detail}>
        {display.detail}
      </span>
    </header>
  );
};

const ChatBubbleAnswer = ({ text }: { text: string }): JSX.Element => {
  const displayText = stripEmbeddedOrchestrationPlanJson(text);
  const parsed = useMemo(() => {
    const state = initStreamParserState();
    hydrateSavedAgentOutput(state, displayText, { terminal: true });
    return state.parsed;
  }, [displayText]);
  const responseDraftText =
    parsed.intermediateText.length > 0 ? parsed.intermediateText : parsed.liveText;
  const finalText =
    parsed.finalText ?? (responseDraftText.length > 0 ? responseDraftText : displayText);

  return (
    <div
      className="inline-agent-stream inline-agent-stream--saved"
      aria-label="Completed agent answer"
    >
      {parsed.progress.length > 0 && (
        <AgentProgressList items={parsed.progress} compact terminal />
      )}
      <AgentStreamSections
        sections={parsed.sections}
        surface="inline"
        terminal
        fallbackFinalText={finalText}
      />
    </div>
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

const shortTaskText = (text: string, max: number): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
};
