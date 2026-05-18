import { useEffect, useMemo, useState } from "react";
import type { ExportApprovalResult, Thread } from "@harness/core";
import {
  backupDefaultDbFileName,
  threadMarkdownDefaultFileName,
} from "./backup-export-model";

type ExportState =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "ready"; result: ExportApprovalResult }
  | { kind: "error"; message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const BackupExportTab = (): JSX.Element => {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    window.harness.state
      .listThreads()
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        setThreadId((current) => current || rows[0]?.id || "");
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === threadId) ?? null,
    [threadId, threads],
  );

  const createDbSnapshotApproval = async (): Promise<void> => {
    const targetPath = await window.harness.app.selectFile({
      defaultDir: backupDefaultDbFileName(),
    });
    if (!targetPath) return;
    setState({ kind: "loading", message: "DB snapshot approval 생성 중..." });
    try {
      const result = await window.harness.state.exportDbSnapshot({ targetPath });
      setState({ kind: "ready", result });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  };

  const createThreadMarkdownApproval = async (): Promise<void> => {
    if (!selectedThread) return;
    const targetPath = await window.harness.app.selectFile({
      defaultDir: threadMarkdownDefaultFileName(selectedThread),
    });
    if (!targetPath) return;
    setState({ kind: "loading", message: "Thread markdown approval 생성 중..." });
    try {
      const result = await window.harness.state.exportThreadMarkdown({
        threadId: selectedThread.id,
        targetPath,
      });
      setState({ kind: "ready", result });
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    }
  };

  return (
    <div className="backup-export">
      <header className="backup-export__header">
        <div>
          <h3>Backup / Export</h3>
          <span>approval-gated file_write exports</span>
        </div>
      </header>

      <section className="backup-export__grid">
        <article className="backup-export__card">
          <div>
            <h4>DB Snapshot</h4>
            <p>SQLite WAL database snapshot을 새 .db 파일로 내보냅니다.</p>
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void createDbSnapshotApproval()}
            disabled={state.kind === "loading"}
          >
            Create approval
          </button>
        </article>

        <article className="backup-export__card">
          <div>
            <h4>Thread Markdown</h4>
            <p>Thread, TaskRuns, approvals, artifacts 참조를 하나의 .md로 직렬화합니다.</p>
          </div>
          <label className="backup-export__field">
            <span>Thread</span>
            <select
              className="settings-field__input"
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              disabled={threads.length === 0 || state.kind === "loading"}
            >
              {threads.length === 0 ? (
                <option value="">No threads</option>
              ) : (
                threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void createThreadMarkdownApproval()}
            disabled={!selectedThread || state.kind === "loading"}
          >
            Create approval
          </button>
        </article>
      </section>

      {state.kind === "loading" ? (
        <div className="empty-state">{state.message}</div>
      ) : null}
      {state.kind === "error" ? (
        <div className="empty-state" style={{ color: "var(--status-failed)" }}>
          {state.message}
        </div>
      ) : null}
      {state.kind === "ready" ? <ExportApprovalNotice result={state.result} /> : null}
    </div>
  );
};

const ExportApprovalNotice = ({
  result,
}: {
  result: ExportApprovalResult;
}): JSX.Element => (
  <section className="backup-export__notice" aria-label="Export approval created">
    <strong>Approval created</strong>
    <span>
      TaskRun {result.taskRun.id} · approval {result.approval.id}
    </span>
    <code>{result.targetPath}</code>
  </section>
);
