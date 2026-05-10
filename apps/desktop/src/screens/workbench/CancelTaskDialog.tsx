import { useState } from "react";

interface CancelTaskDialogProps {
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export const CancelTaskDialog = ({
  onClose,
  onConfirm,
}: CancelTaskDialogProps): JSX.Element => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-task-title"
      className="dialog-backdrop"
    >
      <div className="dialog">
        <header className="dialog__header">
          <h3 id="cancel-task-title">TaskRun 취소</h3>
        </header>
        <div className="dialog__body">
          <p className="dialog__lede">
            취소하면 진행 중인 모든 pending approval이 거절되고 TaskRun은 종료
            상태(<strong>cancelled</strong>)로 들어갑니다. 되돌릴 수 없습니다.
          </p>
          <label className="form-field">
            <span>취소 사유</span>
            <textarea
              className="textarea"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="왜 이 TaskRun을 취소하는지 간단히 적어주세요"
            />
          </label>
          {error ? <div className="error-message">{error}</div> : null}
        </div>
        <footer className="dialog__footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            돌아가기
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {busy ? "처리 중…" : "TaskRun 취소"}
          </button>
        </footer>
      </div>
    </div>
  );
};
