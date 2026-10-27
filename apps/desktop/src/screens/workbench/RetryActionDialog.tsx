import { useRef, useState } from "react";
import type { Approval } from "@harness/core";

export const RetryActionDialog = ({ approvals, onClose, onPrepared }: {
  approvals: Approval[];
  onClose: () => void;
  onPrepared: () => Promise<void>;
}): JSX.Element => {
  const [sourceId, setSourceId] = useState(approvals[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const source = approvals.find(a => a.id === sourceId);
  const submit = async (): Promise<void> => {
    if (submitting.current || !source || !confirmed || !message.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.harness.conversation.prepareActionRetry({ approvalId: source.id,
        expectedRevision: source.actionRevision ?? 1, expectedExecutionState: source.executionState ?? null,
        reviewMessage: message.trim() });
      await onPrepared();
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div role="dialog" aria-modal="true" aria-labelledby="retry-review-title" className="dialog-backdrop">
    <div className="dialog">
      <header className="dialog__header"><h3 id="retry-review-title">이전 실행 결과 검토</h3></header>
      <div className="dialog__body">
        <p>Timeline과 Files에서 이전 로그와 실제 파일 상태를 확인하세요. 결과가 불확실하면 일부 변경이 이미 반영되었을 수 있습니다.</p>
        <label className="form-field"><span>재시도할 작업</span><select value={sourceId} disabled={busy}
          onChange={e => { setSourceId(e.target.value); setConfirmed(false); setMessage(""); }}>
          {approvals.map(a => <option key={a.id} value={a.id}>{a.actionSummary}</option>)}
        </select></label>
        <p>이전 실행 상태: <strong>{source?.executionState ?? "실행 claim 없음"}</strong> · 승인 {source?.id}</p>
        <pre className="approval-card__details">{JSON.stringify(source?.proposedAction, null, 2)}</pre>
        <p>새 승인은 수동 승인 대기로 생성됩니다. 파일의 이전 내용이나 삭제 대상 정보가 바뀌었다면 세부 지정을 갱신하세요.</p>
        <label className="form-field"><span>실행 결과 검토 내용</span><textarea value={message} maxLength={4000} rows={3}
          disabled={busy} onChange={e => setMessage(e.target.value)} /></label>
        <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /> 이전 결과와 재실행 시 중복 부수효과 가능성을 확인했습니다.</label>
        {error && <div role="alert" className="error-message">{error}</div>}
      </div>
      <footer className="dialog__footer">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>닫기</button>
        <button type="button" className="btn btn--primary" disabled={busy || !source || !confirmed || !message.trim()}
          onClick={() => void submit()}>{busy ? "생성 중…" : "새 승인 생성"}</button>
      </footer>
    </div>
  </div>;
};
