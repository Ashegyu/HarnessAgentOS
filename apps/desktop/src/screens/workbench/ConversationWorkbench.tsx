import { useEffect, useRef } from "react";
import type { TaskRun, ThreadDetail } from "@harness/core";
import { ConversationInput, type ConversationMode } from "./ConversationInput";
import { TaskRunStatusBadge } from "./TaskRunStatusBadge";

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
  agentAvailable: boolean;
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
  agentAvailable,
}: ConversationWorkbenchProps): JSX.Element => {
  if (detailState.kind === "idle") {
    return (
      <main className="conversation-workbench" aria-label="Conversation workbench">
        <header className="panel-header">
          <span>Workbench</span>
          <span style={{ color: "var(--text-muted)" }}>스레드 미선택</span>
        </header>
        <div className="conversation-workbench__greeting">
          <h1>HarnessAgentOS</h1>
          <p>
            왼쪽에서 스레드를 선택하거나 <strong>+ 새 작업</strong>으로 시작하세요.
          </p>
        </div>
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
      <ChatHeader thread={detailState.detail.thread} />
      <ChatTranscript
        detail={detailState.detail}
        selectedTaskRunId={selectedTaskRunId}
        onSelectTaskRun={onSelectTaskRun}
        onDeleteTask={onDeleteTask}
      />
      <ConversationInput
        threadId={threadId}
        threadTargetDir={threadTargetDir}
        agentAvailable={agentAvailable}
        onSubmit={onCreateTask}
      />
    </main>
  );
};

const ChatHeader = ({ thread }: { thread: ThreadDetail["thread"] }) => (
  <header className="panel-header">
    <span>{thread.title}</span>
    <span
      style={{ color: "var(--text-muted)" }}
      title={thread.targetDir ?? "대상 폴더 미선택"}
    >
      {thread.targetDir ?? "대상 폴더 미선택"}
    </span>
  </header>
);

const ChatTranscript = ({
  detail,
  selectedTaskRunId,
  onSelectTaskRun,
  onDeleteTask,
}: {
  detail: ThreadDetail;
  selectedTaskRunId: string | null;
  onSelectTaskRun: (id: string) => void;
  onDeleteTask: (id: string) => Promise<void>;
}): JSX.Element => {
  const { taskRuns, agentAnswers } = detail;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Sort oldest-first so the transcript reads top-down like a chat log.
  const ordered = [...taskRuns].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  // Auto-scroll to latest message whenever the message count changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [ordered.length, selectedTaskRunId]);

  if (ordered.length === 0) {
    return (
      <div className="chat-transcript" ref={scrollRef}>
        <div className="empty-state">
          아직 대화가 없습니다. 아래에 메시지를 입력해 시작하세요.
        </div>
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
}: {
  taskRun: TaskRun;
  answer: string | undefined;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}): JSX.Element => {
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
          {answer && answer.length > 0 ? (
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
