import { useMemo, useState } from "react";
import type { Approval, TaskRun, TaskRunStatus } from "@harness/core";
import { CancelTaskDialog } from "./CancelTaskDialog";

interface TaskRunStateActionsProps {
  taskRun: TaskRun;
  approvals: Approval[];
  onChanged: () => Promise<void>;
}

const isTerminal = (status: TaskRunStatus): boolean =>
  status === "done" || status === "cancelled";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const TaskRunStateActions = ({
  taskRun,
  approvals,
  onChanged,
}: TaskRunStateActionsProps): JSX.Element | null => {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  const lastApproved = useMemo(
    () =>
      [...approvals]
        .reverse()
        .find(
          (a) =>
            a.status === "approved" ||
            a.status === "always_approved_for_run" ||
            a.status === "executed",
        ),
    [approvals],
  );

  if (isTerminal(taskRun.status)) return null;

  const canPause =
    taskRun.status === "running" ||
    taskRun.status === "waiting_for_approval";
  const canResume = taskRun.status === "paused";
  const canRetry =
    (taskRun.status === "blocked" || taskRun.status === "quality_failed") &&
    !!lastApproved;
  const canCancel = !isTerminal(taskRun.status);

  const wrap = async (
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-state-actions">
      <div className="task-state-actions__row">
        <span className="muted">TaskRun status: {taskRun.status}</span>
      </div>
      <div className="task-state-actions__buttons">
        {canPause ? (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void wrap(() =>
                window.harness.conversation.pauseTask({
                  taskRunId: taskRun.id,
                }),
              )
            }
            disabled={busy}
          >
            Pause
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              void wrap(() =>
                window.harness.conversation.resumeTask({
                  taskRunId: taskRun.id,
                }),
              )
            }
            disabled={busy}
          >
            Resume
          </button>
        ) : null}
        {canRetry && lastApproved ? (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void wrap(() =>
                window.harness.runner.retryApproval({
                  approvalId: lastApproved.id,
                }),
              )
            }
            disabled={busy}
            title="가장 최근에 승인된 action을 다시 실행합니다. shell 명령은 부수효과가 발생할 수 있습니다."
          >
            Retry last action
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="btn"
            onClick={() => setShowCancel(true)}
            disabled={busy}
          >
            Cancel TaskRun
          </button>
        ) : null}
      </div>
      {actionError ? <div className="error-message">{actionError}</div> : null}
      {showCancel ? (
        <CancelTaskDialog
          onClose={() => setShowCancel(false)}
          onConfirm={async (reason) => {
            await window.harness.conversation.cancelTask({
              taskRunId: taskRun.id,
              reason,
            });
            await onChanged();
          }}
        />
      ) : null}
    </div>
  );
};
