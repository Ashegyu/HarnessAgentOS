import { useState } from "react";
import type { Thread } from "@harness/core";

type ThreadsState =
  | { kind: "loading" }
  | { kind: "ready"; threads: Thread[] }
  | { kind: "error"; message: string };

interface ThreadSidebarProps {
  state: ThreadsState;
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onCreateThread: (input: {
    title: string;
    targetDir?: string;
  }) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onRetry: () => void;
  onOpenAgents: () => void;
  agentsActive: boolean;
}

const formatRelative = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export const ThreadSidebar = ({
  state,
  selectedThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  onRetry,
  onOpenAgents,
  agentsActive,
}: ThreadSidebarProps): JSX.Element => {
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCreate = (): void => {
    setCreating(true);
    setError(null);
  };
  const cancelCreate = (): void => {
    setCreating(false);
    setTitle("");
    setTargetDir("");
    setError(null);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (title.trim().length === 0) {
      setError("제목을 입력하세요");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: { title: string; targetDir?: string } = {
        title: title.trim(),
      };
      if (targetDir.trim().length > 0) payload.targetDir = targetDir.trim();
      await onCreateThread(payload);
      cancelCreate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="thread-sidebar" aria-label="Thread sidebar">
      <header className="panel-header">
        <span>Threads</span>
        {!creating && (
          <button type="button" onClick={startCreate}>
            + 새 작업
          </button>
        )}
      </header>
      <div className="panel-body">
        {creating && (
          <form className="thread-create-form" onSubmit={submit}>
            <label className="thread-create-form__field">
              <span>제목</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 결제 모듈 리팩토링"
                autoFocus
                disabled={submitting}
              />
            </label>
            <label className="thread-create-form__field">
              <span>대상 폴더 (선택)</span>
              <div className="thread-create-form__path-row">
                <input
                  type="text"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="예: C:\\Users\\me\\Code\\my-project"
                  disabled={submitting}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    setError(null);
                    try {
                      const picked = await window.harness.app.selectDirectory();
                      if (picked) setTargetDir(picked);
                    } catch (e) {
                      setError(
                        `폴더 선택 실패: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    }
                  }}
                  disabled={submitting}
                >
                  찾아보기…
                </button>
              </div>
            </label>
            {error && <div className="thread-create-form__error">{error}</div>}
            <div className="thread-create-form__actions">
              <button type="button" onClick={cancelCreate} disabled={submitting}>
                취소
              </button>
              <button type="submit" disabled={submitting}>
                {submitting ? "생성 중…" : "생성"}
              </button>
            </div>
          </form>
        )}

        {state.kind === "loading" && (
          <div className="empty-state">스레드 불러오는 중…</div>
        )}

        {state.kind === "error" && (
          <div className="thread-list__error">
            <div>스레드를 불러오지 못했습니다.</div>
            <code className="thread-list__error-msg">{state.message}</code>
            <button type="button" onClick={onRetry}>
              다시 시도
            </button>
          </div>
        )}

        {state.kind === "ready" && state.threads.length === 0 && !creating && (
          <div className="empty-state">작업 스레드 없음</div>
        )}

        {state.kind === "ready" && state.threads.length > 0 && (
          <ul className="thread-list">
            {state.threads.map((t) => (
              <li key={t.id} className="thread-list__row">
                <button
                  type="button"
                  className={`thread-list__item${
                    selectedThreadId === t.id ? " thread-list__item--active" : ""
                  }`}
                  onClick={() => onSelectThread(t.id)}
                  title={t.targetDir ?? "대상 폴더 미지정"}
                >
                  <span className="thread-list__title">{t.title}</span>
                  <span className="thread-list__meta">
                    {formatRelative(t.updatedAt)}
                  </span>
                  {t.targetDir && (
                    <span className="thread-list__target" title={t.targetDir}>
                      {t.targetDir}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="thread-list__delete"
                  disabled={deletingId === t.id}
                  title="스레드 삭제"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`"${t.title}" 스레드를 삭제하시겠습니까?\n\n포함된 모든 작업이 함께 삭제됩니다.`)) return;
                    setDeletingId(t.id);
                    try {
                      await onDeleteThread(t.id);
                    } finally {
                      setDeletingId(null);
                    }
                  }}
                >
                  {deletingId === t.id ? "…" : "×"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-nav">
        <button
          type="button"
          className={`sidebar-nav__btn${agentsActive ? " sidebar-nav__btn--active" : ""}`}
          onClick={onOpenAgents}
          title="Agents & Orchestration"
        >
          ⚙ Agents
        </button>
      </div>
    </aside>
  );
};
