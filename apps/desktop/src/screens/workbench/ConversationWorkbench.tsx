import type { ThreadDetail } from "@harness/core";
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
  onCreateTask: (input: {
    userRequest: string;
    targetDir?: string;
    mode: ConversationMode;
  }) => Promise<void>;
  threadTargetDir: string | undefined;
  threadId: string | null;
  agentAvailable: boolean;
}

const formatRelative = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export const ConversationWorkbench = ({
  detailState,
  selectedTaskRunId,
  onSelectTaskRun,
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

  const { thread, taskRuns } = detailState.detail;

  return (
    <main className="conversation-workbench" aria-label="Conversation workbench">
      <header className="panel-header">
        <span>{thread.title}</span>
        <span
          style={{ color: "var(--text-muted)" }}
          title={thread.targetDir ?? "대상 폴더 미선택"}
        >
          {thread.targetDir ?? "대상 폴더 미선택"}
        </span>
      </header>
      <div className="task-run-list">
        {taskRuns.length === 0 ? (
          <div className="empty-state">
            아직 TaskRun이 없습니다. 아래에서 작업을 입력하면 plan / checkpoint /
            approval이 생성됩니다.
          </div>
        ) : (
          <ul className="task-run-list__items">
            {taskRuns.map((tr) => {
              const isSelected = selectedTaskRunId === tr.id;
              return (
                <li
                  key={tr.id}
                  className={`task-run-list__item${isSelected ? " task-run-list__item--active" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectTaskRun(tr.id)}
                    className="task-run-list__button"
                  >
                    <div className="task-run-list__row">
                      <span className="task-run-list__title">
                        {tr.userRequest}
                      </span>
                      <TaskRunStatusBadge status={tr.status} />
                    </div>
                    <div className="task-run-list__meta">
                      <span>{formatRelative(tr.createdAt)}</span>
                      <span className="runtime-status-bar__sep">·</span>
                      <span title={tr.targetDir}>{tr.targetDir}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConversationInput
        threadId={threadId}
        threadTargetDir={threadTargetDir}
        agentAvailable={agentAvailable}
        onSubmit={onCreateTask}
      />
    </main>
  );
};
