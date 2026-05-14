import { useEffect, useState } from "react";
import type { AgentPipeline, Thread } from "@harness/core";

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
    pipelineId?: string;
  }) => Promise<void>;
  onDeleteThread: (id: string) => Promise<void>;
  onRetry: () => void;
  /** Counter from parent; when value changes, the create form opens. */
  startCreateSignal?: number;
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
  startCreateSignal,
}: ThreadSidebarProps): JSX.Element => {
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [pipelineId, setPipelineId] = useState<string>("");
  const [pipelines, setPipelines] = useState<AgentPipeline[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load pipelines on mount so the thread-list badge can resolve names.
  // Refresh whenever the create form opens, so a newly-created pipeline
  // appears in the dropdown without remounting the sidebar.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.harness.pipeline.list();
        if (!cancelled) setPipelines(list);
      } catch {
        if (!cancelled) setPipelines([]);
      }
    })();
    return () => { cancelled = true; };
  }, [creating]);

  // Seed dropdown selection with the user's preferred default pipeline
  // when the create form opens, but only if the default still resolves
  // to a real pipeline; otherwise leave at "no pipeline".
  useEffect(() => {
    if (!creating) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.harness.settings.get();
        if (cancelled) return;
        const preferred = settings.orchestration.defaultPipelineId;
        if (preferred && pipelines.some((p) => p.id === preferred)) {
          setPipelineId(preferred);
        } else {
          setPipelineId("");
        }
      } catch {
        if (!cancelled) setPipelineId("");
      }
    })();
    return () => { cancelled = true; };
  }, [creating, pipelines]);

  const startCreate = (): void => {
    setCreating(true);
    setError(null);
  };

  // Parent (SlimRail FAB) can request the create form by bumping the signal.
  // Skip the initial mount (signal undefined or 0) to avoid auto-opening
  // when the user only mounted the drawer.
  useEffect(() => {
    if (startCreateSignal !== undefined && startCreateSignal > 0) {
      setCreating(true);
      setError(null);
    }
  }, [startCreateSignal]);
  const cancelCreate = (): void => {
    setCreating(false);
    setTitle("");
    setTargetDir("");
    setPipelineId("");
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
      const payload: {
        title: string;
        targetDir?: string;
        pipelineId?: string;
      } = { title: title.trim() };
      if (targetDir.trim().length > 0) payload.targetDir = targetDir.trim();
      if (pipelineId.length > 0) payload.pipelineId = pipelineId;
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
        <span className="panel-header__title">Threads</span>
        {!creating && (
          <button
            type="button"
            className="panel-header__action"
            onClick={startCreate}
            aria-label="새 작업"
            data-tooltip="새 작업"
          >
            <span className="panel-header__action-icon" aria-hidden>
              +
            </span>
            <span className="panel-header__action-label">새 작업</span>
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
            {pipelines.length > 0 && (
              <label
                className="thread-create-form__field"
                title="이 스레드의 기본 Pipeline 입니다. 매 메시지마다 채팅 입력 위에서 다른 파이프라인으로 자유롭게 바꿀 수 있습니다."
              >
                <span>기본 Pipeline (변경 가능)</span>
                <select
                  value={pipelineId}
                  onChange={(e) => setPipelineId(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">(없음 — 매 메시지 직접 선택)</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.steps.length} steps)
                    </option>
                  ))}
                </select>
              </label>
            )}
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
            {state.threads.map((t) => {
              const boundPipeline = t.pipelineId
                ? pipelines.find((p) => p.id === t.pipelineId)
                : null;
              return (
              <li key={t.id} className="thread-list__row">
                <button
                  type="button"
                  className={`thread-list__item${
                    selectedThreadId === t.id ? " thread-list__item--active" : ""
                  }`}
                  onClick={() => onSelectThread(t.id)}
                >
                  <span
                    className="thread-list__title"
                    data-tooltip={t.title}
                    title={t.title}
                  >
                    {t.title}
                  </span>
                  <span className="thread-list__meta">
                    {formatRelative(t.updatedAt)}
                  </span>
                  {t.targetDir && (
                    <span
                      className="thread-list__target"
                      data-tooltip={t.targetDir}
                      title={t.targetDir}
                    >
                      {t.targetDir}
                    </span>
                  )}
                  {t.pipelineId && (
                    <span
                      className="thread-list__pipeline"
                      data-tooltip={boundPipeline?.name ?? "(삭제됨)"}
                      title={
                        boundPipeline
                          ? `기본 Pipeline: ${boundPipeline.name} — 매 메시지마다 변경 가능`
                          : "참조하던 파이프라인이 삭제됨"
                      }
                    >
                      ▣ {boundPipeline?.name ?? "(없음)"}
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
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
};
