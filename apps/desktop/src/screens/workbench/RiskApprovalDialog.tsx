import { useState } from "react";
import type { QualityGateResult } from "@harness/core";

interface RiskApprovalDialogProps {
  gate: QualityGateResult;
  onClose: () => void;
  onApprove: (message: string) => Promise<void>;
}

export const RiskApprovalDialog = ({
  gate,
  onClose,
  onApprove,
}: RiskApprovalDialogProps): JSX.Element => {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = message.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onApprove(trimmed);
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
      aria-labelledby="risk-approval-title"
      className="dialog-backdrop"
    >
      <div className="dialog">
        <header className="dialog__header">
          <h3 id="risk-approval-title">Known risk 승인</h3>
        </header>
        <div className="dialog__body">
          <p className="dialog__lede">
            Quality gate가 <strong>{gate.status}</strong> 상태입니다. 사유를
            기록한 뒤에만 ready_for_review로 진행할 수 있습니다.
          </p>
          {gate.knownRisks.length > 0 ? (
            <ul className="risk-list">
              {gate.knownRisks.map((risk, idx) => (
                <li key={idx}>{risk}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">기록된 위험은 없지만 명시적 승인이 필요합니다.</p>
          )}
          <label className="form-field">
            <span>승인 사유</span>
            <textarea
              className="textarea"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="왜 이 위험을 감수하고 진행하는지 간단히 적어주세요"
            />
          </label>
          {error ? <div className="error-message">{error}</div> : null}
        </div>
        <footer className="dialog__footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {busy ? "처리 중…" : "위험을 감수하고 승인"}
          </button>
        </footer>
      </div>
    </div>
  );
};
