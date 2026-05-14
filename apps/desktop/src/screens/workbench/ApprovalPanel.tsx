import { useState } from "react";
import type { Approval, ProposedActionDetails } from "@harness/core";
import { ConfigureActionDialog } from "./ConfigureActionDialog";

interface ApprovalPanelProps {
  approvals: Approval[];
  taskRunTargetDir: string;
  onApprove: (input: {
    approvalId: string;
    message?: string;
    scope?: "once" | "run_action_class";
  }) => Promise<void>;
  onReject: (input: { approvalId: string; message: string }) => Promise<void>;
  onRedirect: (input: { instruction: string }) => Promise<void>;
  onConfigure: (input: {
    approvalId: string;
    details: ProposedActionDetails;
  }) => Promise<void>;
  onExecute: (input: { approvalId: string }) => Promise<void>;
  /**
   * True when this TaskRun was created by picking a pipeline at submit
   * time. Pipeline pick IS the user's consent for every approval the
   * run produces (subject to the profile blocklist), so the auto-approve
   * useEffect in WorkbenchShell will approve+execute them within
   * milliseconds. We render pending cards as read-only "자동 처리 중…"
   * audit rows so the user doesn't see — and accidentally click —
   * manual 승인/거절/세부 지정 buttons that race with the auto path.
   */
  pipelineAutoLaunched: boolean;
}

const ACTION_RISK_HINT: Record<string, "low" | "medium" | "high"> = {
  file_write: "medium",
  shell: "medium",
  dependency_install: "high",
  network: "high",
  git_commit: "high",
  skill_script: "high",
  orchestration_plan: "high",
};

const HIGH_RISK_BLOCKED: ReadonlySet<string> = new Set([
  "dependency_install",
  "git_commit",
  "network",
  "skill_script",
  "orchestration_plan",
]);

export const ApprovalPanel = ({
  approvals,
  taskRunTargetDir,
  onApprove,
  onReject,
  onRedirect,
  onConfigure,
  onExecute,
  pipelineAutoLaunched,
}: ApprovalPanelProps): JSX.Element => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [redirectInstruction, setRedirectInstruction] = useState("");
  const [configuring, setConfiguring] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guardedApprove = async (
    approvalId: string,
    scope?: "once" | "run_action_class",
  ): Promise<void> => {
    setBusyId(approvalId);
    setError(null);
    try {
      const payload: { approvalId: string; scope?: "once" | "run_action_class" } = {
        approvalId,
      };
      if (scope) payload.scope = scope;
      await onApprove(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const guardedReject = async (approvalId: string): Promise<void> => {
    if (rejectReason.trim().length === 0) {
      setError("거절 이유를 입력하세요");
      return;
    }
    setBusyId(approvalId);
    setError(null);
    try {
      await onReject({ approvalId, message: rejectReason.trim() });
      setRejectingId(null);
      setRejectReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const guardedRedirect = async (): Promise<void> => {
    if (redirectInstruction.trim().length === 0) {
      setError("수정 지시 내용을 입력하세요");
      return;
    }
    setBusyId("__redirect__");
    setError(null);
    try {
      await onRedirect({ instruction: redirectInstruction.trim() });
      setRedirecting(false);
      setRedirectInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const guardedExecute = async (approvalId: string): Promise<void> => {
    setBusyId(approvalId);
    setError(null);
    try {
      await onExecute({ approvalId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const guardedConfigure = async (
    approval: Approval,
    details: ProposedActionDetails,
  ): Promise<void> => {
    setBusyId(approval.id);
    setError(null);
    try {
      await onConfigure({ approvalId: approval.id, details });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusyId(null);
    }
  };

  const pending = approvals.filter((a) => a.status === "pending");
  const approved = approvals.filter(
    (a) => a.status === "approved" || a.status === "always_approved_for_run",
  );
  const rejected = approvals.filter((a) => a.status === "rejected");
  const executed = approvals.filter((a) => a.status === "executed");

  const renderCard = (
    a: Approval,
    mode: "pending" | "approved" | "decided",
  ): JSX.Element => {
    const risk = ACTION_RISK_HINT[a.actionType] ?? "low";
    const blocked = HIGH_RISK_BLOCKED.has(a.actionType);
    return (
      <article key={a.id} className={`approval-card approval-card--${risk}`}>
        <header className="approval-card__header">
          <span className="approval-card__type">{a.actionType}</span>
          <span className={`status-badge status-badge--${riskKind(risk)}`}>
            {risk}
          </span>
        </header>
        <p className="approval-card__summary">{a.actionSummary}</p>
        {a.proposedAction && (
          <pre className="approval-card__details">
            {JSON.stringify(a.proposedAction, null, 2)}
          </pre>
        )}
        {mode === "pending" && pipelineAutoLaunched ? (
          // Pipeline-pick consent already covers this approval; the
          // auto-approve useEffect will mark it approved+executed in
          // the next tick. Showing the manual buttons would race the
          // auto path and confuse the user about whether they need
          // to act. Render a read-only audit indicator instead.
          <p className="approval-card__auto-hint">
            자동 처리 중… (파이프라인 선택으로 사전 승인됨)
          </p>
        ) : mode === "pending" && rejectingId === a.id ? (
          <div className="approval-card__reject">
            <textarea
              placeholder="거절 이유 (필수)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={2}
            />
            <div className="approval-card__actions">
              <button
                type="button"
                onClick={() => {
                  setRejectingId(null);
                  setRejectReason("");
                  setError(null);
                }}
                disabled={busyId === a.id}
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void guardedReject(a.id)}
                disabled={busyId === a.id}
              >
                거절 확정
              </button>
            </div>
          </div>
        ) : mode === "pending" ? (
          <div className="approval-card__actions">
            <button
              type="button"
              onClick={() => setConfiguring(a)}
              disabled={busyId !== null || blocked}
              title={blocked ? "Phase 3 MVP에서 차단됨" : "실행 세부 지정"}
            >
              {a.proposedAction ? "세부 수정" : "세부 지정"}
            </button>
            <button
              type="button"
              onClick={() => void guardedApprove(a.id, "once")}
              disabled={busyId !== null}
            >
              승인
            </button>
            <button
              type="button"
              onClick={() => void guardedApprove(a.id, "run_action_class")}
              disabled={busyId !== null}
              title="이 TaskRun 안의 pending 상태인 같은 actionType approvals를 함께 승인합니다."
            >
              같은 종류 모두 승인
            </button>
            <button
              type="button"
              onClick={() => {
                setRejectingId(a.id);
                setError(null);
              }}
              disabled={busyId !== null}
            >
              거절
            </button>
          </div>
        ) : mode === "approved" && pipelineAutoLaunched ? (
          <p className="approval-card__auto-hint">
            자동 실행 대기 중… (파이프라인 선택으로 사전 승인됨)
          </p>
        ) : mode === "approved" ? (
          <div className="approval-card__actions">
            <button
              type="button"
              onClick={() => setConfiguring(a)}
              disabled={busyId !== null || blocked}
            >
              {a.proposedAction ? "세부 수정" : "세부 지정"}
            </button>
            <button
              type="button"
              onClick={() => void guardedExecute(a.id)}
              disabled={busyId !== null || !a.proposedAction || blocked}
              title={
                blocked
                  ? "Phase 3 MVP에서 차단됨"
                  : a.proposedAction
                    ? "approved 상태인 action을 실행합니다."
                    : "먼저 세부 지정이 필요합니다."
              }
            >
              {busyId === a.id ? "실행 중…" : "실행"}
            </button>
          </div>
        ) : null}
        {a.decisionMessage && (
          <p className="approval-card__decision">{a.decisionMessage}</p>
        )}
      </article>
    );
  };

  return (
    <section className="approval-panel" aria-label="Approval panel">
      {pending.length === 0 &&
        approved.length === 0 &&
        rejected.length === 0 &&
        executed.length === 0 && (
          <div className="empty-state">승인 대기 없음</div>
        )}

      {pending.length > 0 && (
        <div className="approval-panel__list">
          {pending.map((a) => renderCard(a, "pending"))}
          {/* "수정 지시" lets the user redirect the run with a fresh
              instruction — useful when reviewing a manual approval.
              For pipeline-auto runs the user already committed to the
              pipeline at submit time, so showing this would race the
              auto path. They can still cancel via the TaskRun-level
              Cancel button. */}
          {!pipelineAutoLaunched && (
          <div className="approval-panel__redirect">
            {redirecting ? (
              <>
                <textarea
                  placeholder="다른 방향 또는 수정 지시 내용"
                  value={redirectInstruction}
                  onChange={(e) => setRedirectInstruction(e.target.value)}
                  rows={3}
                />
                <div className="approval-card__actions">
                  <button
                    type="button"
                    onClick={() => {
                      setRedirecting(false);
                      setRedirectInstruction("");
                      setError(null);
                    }}
                    disabled={busyId === "__redirect__"}
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onClick={() => void guardedRedirect()}
                    disabled={busyId === "__redirect__"}
                  >
                    재계획 요청
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRedirecting(true);
                  setError(null);
                }}
                disabled={busyId !== null}
              >
                수정 지시
              </button>
            )}
          </div>
          )}
        </div>
      )}

      {approved.length > 0 && (
        <div className="approval-panel__decided">
          <header className="panel-header">승인됨 (실행 가능)</header>
          {approved.map((a) => renderCard(a, "approved"))}
        </div>
      )}

      {executed.length > 0 && (
        <div className="approval-panel__decided">
          <header className="panel-header">실행 완료</header>
          {executed.map((a) => renderCard(a, "decided"))}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="approval-panel__decided">
          <header className="panel-header">거절/취소</header>
          {rejected.map((a) => renderCard(a, "decided"))}
        </div>
      )}

      {error && <div className="approval-panel__error">{error}</div>}

      {configuring && (
        <ConfigureActionDialog
          approval={configuring}
          taskRunTargetDir={taskRunTargetDir}
          onSave={(details) => guardedConfigure(configuring, details)}
          onClose={() => setConfiguring(null)}
        />
      )}
    </section>
  );
};

const riskKind = (risk: "low" | "medium" | "high"): string =>
  risk === "high" ? "failed" : risk === "medium" ? "pending" : "neutral";
