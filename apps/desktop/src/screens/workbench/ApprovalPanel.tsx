import { useState } from "react";
import type {
  Approval,
  A2ARefinementAttempt,
  AutoApproveDecision,
  Checkpoint,
  ProposedActionDetails,
  ShadowPreview,
} from "@harness/core";
import {
  A2A_REFINEMENT_MAX_ATTEMPTS_PER_SIGNATURE,
  A2A_REFINEMENT_MAX_ATTEMPTS_PER_TASK_RUN,
} from "@harness/core";
import { ConfigureActionDialog } from "./ConfigureActionDialog";
import { ApprovalDecisionTrace } from "./ApprovalDecisionTrace";
import {
  autoExecutableRunnerApprovalIssue,
  isRunnerExecutionApproval,
} from "./auto-execution-plan";

interface ApprovalPanelProps {
  approvals: Approval[];
  checkpoints?: Checkpoint[];
  refinementAttempts?: A2ARefinementAttempt[];
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
   * run produces (subject to profile blocks and budgets), so the auto-approve
   * useEffect in WorkbenchShell will approve+execute them within
   * milliseconds. We render pending cards as read-only "자동 처리 중…"
   * audit rows so the user doesn't see — and accidentally click —
   * manual 승인/거절/세부 지정 buttons that race with the auto path. A
   * blocked decision falls back to the manual controls instead.
  */
  pipelineAutoLaunched: boolean;
  getPipelineAutoDecision?: (approval: Approval) => AutoApproveDecision;
}

const ACTION_RISK_HINT: Record<string, "low" | "medium" | "high"> = {
  capability_use: "low",
  model_use: "medium",
  file_patch: "medium",
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

const EXECUTION_NOT_REQUIRED: ReadonlySet<string> = new Set([
  "capability_use",
  "model_use",
]);

export const ApprovalPanel = ({
  approvals,
  checkpoints = [],
  refinementAttempts = [],
  taskRunTargetDir,
  onApprove,
  onReject,
  onRedirect,
  onConfigure,
  onExecute,
  pipelineAutoLaunched,
  getPipelineAutoDecision,
}: ApprovalPanelProps): JSX.Element => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [redirectInstruction, setRedirectInstruction] = useState("");
  const [configuring, setConfiguring] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shadowPreviews, setShadowPreviews] = useState<
    Record<string, ShadowPreview>
  >({});

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

  const guardedShadowPreview = async (approvalId: string): Promise<void> => {
    setBusyId(approvalId);
    setError(null);
    try {
      const preview = await window.harness.shadow.createPreview({ approvalId });
      setShadowPreviews((prev) => ({ ...prev, [approvalId]: preview }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    const refinementDetail = refinementDetailForApproval(
      a,
      checkpoints,
      refinementAttempts,
    );
    const policy = a.policyEvaluation;
    const risk =
      policy?.riskLevel === "blocked"
        ? "high"
        : (policy?.riskLevel ?? ACTION_RISK_HINT[a.actionType] ?? "low");
    const blocked =
      policy?.decision === "blocked" || HIGH_RISK_BLOCKED.has(a.actionType);
    const canPreviewShadow =
      !blocked &&
      ((a.actionType === "file_write" &&
        a.proposedAction?.type === "file_write" &&
        Boolean(a.proposedAction.filePatch)) ||
        (a.actionType === "file_patch" &&
          a.proposedAction?.type === "file_patch" &&
          Boolean(a.proposedAction.unifiedPatch)));
    const shadowPreview = shadowPreviews[a.id];
    const runnerAutoIssue = isRunnerExecutionApproval(a)
      ? autoExecutableRunnerApprovalIssue(a)
      : null;
    const pipelineDecision = pipelineAutoLaunched
      ? getPipelineAutoDecision?.(a)
      : undefined;
    const pipelinePolicyIssue =
      pipelineDecision?.approved === false ? pipelineDecision.reason : null;
    const pipelineAutoIssue = runnerAutoIssue ?? pipelinePolicyIssue;
    const pipelineAutoCanHandle =
      pipelineAutoLaunched && pipelineAutoIssue === null;
    return (
      <article
        key={a.id}
        id={`approval-card-${a.id}`}
        className={`approval-card approval-card--${risk}`}
      >
        <header className="approval-card__header">
          <span className="approval-card__type">{a.actionType}</span>
          <span className={`status-badge status-badge--${riskKind(risk)}`}>
            {risk}
          </span>
        </header>
        <p className="approval-card__summary">{a.actionSummary}</p>
        {policy && (
          <p className="approval-card__policy">
            policy: {policy.decision} · {policy.reason}
            {!policy.allowAutoApprove ? " · 수동 승인 필요" : ""}
          </p>
        )}
        {refinementDetail ? (
          <A2ARefinementApprovalDetails detail={refinementDetail} />
        ) : null}
        {a.proposedAction && (
          <pre className="approval-card__details">
            {JSON.stringify(a.proposedAction, null, 2)}
          </pre>
        )}
        <ApprovalDecisionTrace approval={a} />
        {pipelineAutoLaunched && pipelineAutoIssue !== null && (
          <p className="approval-card__auto-hint">
            자동 처리 제외: {pipelineAutoIssue}. 검토 후 직접 처리하세요.
          </p>
        )}
        {shadowPreview && (
          <p className="approval-card__auto-hint">
            Shadow preview 생성됨: <code>{shadowPreview.relativePath}</code> ·
            artifacts {shadowPreview.artifactIds.join(", ")}
          </p>
        )}
        {a.actionType === "capability_use" && (
          <p className="approval-card__auto-hint">
            승인하면 이 Skill 후보가 다음 Agent 프롬프트 컨텍스트에 포함됩니다.
            파일/명령 실행은 하지 않습니다.
          </p>
        )}
        {a.actionType === "model_use" && (
          <p className="approval-card__auto-hint">
            승인하면 이 Learner 모델 추천이 다음 Agent 호출 모델로 반영됩니다.
            파일/명령 실행은 하지 않습니다.
          </p>
        )}
        {mode === "pending" && pipelineAutoCanHandle ? (
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
              disabled={
                busyId !== null ||
                blocked ||
                EXECUTION_NOT_REQUIRED.has(a.actionType)
              }
              title={
                EXECUTION_NOT_REQUIRED.has(a.actionType)
                  ? "이 approval은 실행 세부 지정이 필요하지 않습니다"
                  : blocked
                    ? "Phase 3 MVP에서 차단됨"
                    : "실행 세부 지정"
              }
            >
              {a.proposedAction ? "세부 수정" : "세부 지정"}
            </button>
            <button
              type="button"
              onClick={() => void guardedShadowPreview(a.id)}
              disabled={busyId !== null || !canPreviewShadow}
              title={
                canPreviewShadow
                  ? "실제 workspace에 쓰기 전에 shadow workspace에서 diff를 생성합니다."
                  : "file_write/file_patch 세부 지정 후 사용할 수 있습니다."
              }
            >
              Shadow preview
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
        ) : mode === "approved" && EXECUTION_NOT_REQUIRED.has(a.actionType) ? (
          <p className="approval-card__auto-hint">
            승인됨 — 다음 Agent 호출에서 추천 컨텍스트로 반영됩니다.
          </p>
        ) : mode === "approved" && pipelineAutoCanHandle ? (
          <p className="approval-card__auto-hint">
            자동 실행 대기 중… (파이프라인 선택으로 사전 승인됨)
          </p>
        ) : mode === "approved" ? (
          <div className="approval-card__actions">
            <button
              type="button"
              onClick={() => setConfiguring(a)}
              disabled={
                busyId !== null ||
                blocked ||
                EXECUTION_NOT_REQUIRED.has(a.actionType)
              }
            >
              {a.proposedAction ? "세부 수정" : "세부 지정"}
            </button>
            <button
              type="button"
              onClick={() => void guardedShadowPreview(a.id)}
              disabled={busyId !== null || !canPreviewShadow}
              title={
                canPreviewShadow
                  ? "실제 workspace에 쓰기 전에 shadow workspace에서 diff를 생성합니다."
                  : "file_write/file_patch 세부 지정 후 사용할 수 있습니다."
              }
            >
              Shadow preview
            </button>
            <button
              type="button"
              onClick={() => void guardedExecute(a.id)}
              disabled={
                busyId !== null ||
                !a.proposedAction ||
                blocked ||
                EXECUTION_NOT_REQUIRED.has(a.actionType)
              }
              title={
                EXECUTION_NOT_REQUIRED.has(a.actionType)
                  ? "이 approval은 runner 실행 대상이 아닙니다"
                  : blocked
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
          <header className="panel-header">승인됨 / 실행 대기</header>
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

interface A2ARefinementApprovalDetail {
  attempt: A2ARefinementAttempt;
  signatureAttemptCount: number;
  taskRunAttemptCount: number;
}

const A2ARefinementApprovalDetails = ({
  detail,
}: {
  detail: A2ARefinementApprovalDetail;
}): JSX.Element => {
  const { attempt } = detail;
  return (
    <section className="approval-card__a2a" aria-label="A2A refinement approval">
      <header className="approval-card__a2a-header">
        <strong>A2A refinement approval</strong>
        <span>attempt {attempt.attemptIndex + 1}</span>
      </header>
      <dl className="approval-card__a2a-grid">
        <div>
          <dt>endpoint</dt>
          <dd>{attempt.endpointId}</dd>
        </div>
        <div>
          <dt>target</dt>
          <dd>{attempt.targetInvocationId}</dd>
        </div>
        <div>
          <dt>parent task</dt>
          <dd>{attempt.parentRemoteTaskId ?? "none"}</dd>
        </div>
        <div>
          <dt>context</dt>
          <dd>{attempt.parentRemoteContextId ?? "none"}</dd>
        </div>
        <div>
          <dt>loop guard</dt>
          <dd>
            signature {detail.signatureAttemptCount}/
            {A2A_REFINEMENT_MAX_ATTEMPTS_PER_SIGNATURE} · task run{" "}
            {detail.taskRunAttemptCount}/{A2A_REFINEMENT_MAX_ATTEMPTS_PER_TASK_RUN}
          </dd>
        </div>
        <div>
          <dt>references</dt>
          <dd>{attempt.referenceArtifactIds.length} artifact(s)</dd>
        </div>
      </dl>
      {attempt.stopReason ? (
        <p className="approval-card__auto-hint">stop reason: {attempt.stopReason}</p>
      ) : null}
    </section>
  );
};

const refinementDetailForApproval = (
  approval: Approval,
  checkpoints: readonly Checkpoint[],
  attempts: readonly A2ARefinementAttempt[],
): A2ARefinementApprovalDetail | null => {
  if (approval.actionType !== "network") return null;
  const checkpoint = checkpoints.find((row) => row.id === approval.checkpointId);
  const stateRef = parseRefinementStateRef(checkpoint?.stateRef);
  if (!stateRef) return null;
  const attempt = attempts.find((row) => row.id === stateRef.a2aRefinementAttemptId);
  if (!attempt) return null;
  return {
    attempt,
    signatureAttemptCount: attempts.filter(
      (row) =>
        row.taskRunId === attempt.taskRunId &&
        row.targetInvocationId === attempt.targetInvocationId &&
        row.feedbackSignature === attempt.feedbackSignature,
    ).length,
    taskRunAttemptCount: attempts.filter(
      (row) => row.taskRunId === attempt.taskRunId,
    ).length,
  };
};

const parseRefinementStateRef = (
  raw: string | undefined,
): { a2aRefinementAttemptId: string } | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { a2aRefinementAttemptId?: unknown })
        .a2aRefinementAttemptId === "string"
    ) {
      return {
        a2aRefinementAttemptId: (parsed as { a2aRefinementAttemptId: string })
          .a2aRefinementAttemptId,
      };
    }
  } catch {
    return null;
  }
  return null;
};
