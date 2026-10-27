import { useMemo, useState } from "react";
import type { Approval, TaskRun, TaskRunStatus } from "@harness/core";
import { canReviewApprovalExecution } from "@harness/core";
import { CancelTaskDialog } from "./CancelTaskDialog";
import { RetryActionDialog } from "./RetryActionDialog";

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
  const [showRetry, setShowRetry] = useState(false);

  const retryCandidates = useMemo(
    () =>
      approvals.filter(
          (a) =>
            a.taskRunId === taskRun.id && !a.retryApprovalId && a.executionState !== "running" &&
            canReviewApprovalExecution(taskRun.status, a.executionState) &&
            ["file_write", "file_patch", "file_delete", "shell"].includes(a.actionType) && !!a.proposedAction &&
            (a.status === "approved" ||
            a.status === "always_approved_for_run" ||
            a.status === "executed"),
        ),
    [approvals, taskRun.id, taskRun.status],
  );

  if (isTerminal(taskRun.status)) return null;

  const canPause =
    taskRun.status === "running" ||
    taskRun.status === "waiting_for_approval";
  const canStop = taskRun.status === "running";
  const canResume = taskRun.status === "paused";
  const canRetry = retryCandidates.length > 0;
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
        {canStop ? (
          <button
            type="button"
            className="btn"
            onClick={() =>
              void wrap(async () => {
                const result = await window.harness.runner.cancelExecution({
                  taskRunId: taskRun.id,
                });
                if (!result.cancelled) {
                  throw new Error("실행 중인 runner 작업이 없습니다.");
                }
              })
            }
            disabled={busy}
            title="현재 실행 중인 shell/test runner를 중단합니다."
          >
            Stop
          </button>
        ) : null}
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
        {canRetry ? (
          <button
            type="button"
            className="btn"
            onClick={() => setShowRetry(true)}
            disabled={busy}
            title="이전 결과를 검토하고 새 수동 승인을 준비합니다."
          >
            재시도 검토
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
      {showRetry && canRetry && <RetryActionDialog approvals={retryCandidates} onClose={() => setShowRetry(false)} onPrepared={onChanged} />}
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
