import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Approval,
  A2ARefinementProposal,
  Artifact,
  QualityGateResult,
  RepairAttempt,
  TaskRun,
} from "@harness/core";
import { RiskApprovalDialog } from "./RiskApprovalDialog";
import { FeatureHelpButton } from "./FeatureHelpButton";
import {
  buildRepairAttemptRows,
  type RepairAttemptRow,
} from "./quality-repair-model";

interface QualityPanelProps {
  taskRun: TaskRun;
  artifacts: Artifact[];
  approvals: Approval[];
  qualityGates: QualityGateResult[];
  repairAttempts: RepairAttempt[];
  refinementProposals: A2ARefinementProposal[];
  /** Refresh callback after a status change. */
  onTaskRunChanged: () => Promise<void>;
}

type GateState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; gate: QualityGateResult | null }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const formatBoolStatus = (passed: boolean | undefined): string => {
  if (passed === undefined) return "not run";
  return passed ? "passed" : "failed";
};

const statusClass = (status: QualityGateResult["status"]): string => {
  switch (status) {
    case "passed":
      return "status-pill status-pill--passed";
    case "warning":
      return "status-pill status-pill--warning";
    case "failed":
      return "status-pill status-pill--failed";
    default:
      return "status-pill status-pill--neutral";
  }
};

export const QualityPanel = ({
  taskRun,
  artifacts,
  approvals,
  qualityGates,
  repairAttempts,
  refinementProposals,
  onTaskRunChanged,
}: QualityPanelProps): JSX.Element => {
  const [gateState, setGateState] = useState<GateState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [riskDialogOpen, setRiskDialogOpen] = useState(false);
  const [requireFlags, setRequireFlags] = useState({
    requireBuild: false,
    requireTests: true,
    requireSmoke: false,
  });

  const fetchLatest = useCallback(async () => {
    setGateState({ kind: "loading" });
    try {
      const gate = await window.harness.quality.getLatest({
        taskRunId: taskRun.id,
      });
      setGateState({ kind: "ready", gate });
    } catch (e) {
      setGateState({ kind: "error", message: errorMessage(e) });
    }
  }, [taskRun.id]);

  useEffect(() => {
    void fetchLatest();
  }, [fetchLatest]);

  const runEvaluate = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await window.harness.quality.evaluate({
        taskRunId: taskRun.id,
        requireBuild: requireFlags.requireBuild,
        requireTests: requireFlags.requireTests,
        requireSmoke: requireFlags.requireSmoke,
      });
      await fetchLatest();
      await onTaskRunChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [taskRun.id, requireFlags, fetchLatest, onTaskRunChanged]);

  const runRepair = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await window.harness.quality.createRepairPlan({
        taskRunId: taskRun.id,
      });
      await fetchLatest();
      await onTaskRunChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [taskRun.id, fetchLatest, onTaskRunChanged]);

  const runRequestRefinement = useCallback(
    async (proposal: A2ARefinementProposal) => {
      setBusy(true);
      setActionError(null);
      try {
        await window.harness.agent.requestRefinement({
          taskRunId: proposal.taskRunId,
          targetInvocationId: proposal.targetInvocationId,
          feedbackSourceKind: proposal.feedbackSourceKind,
          ...(proposal.feedbackSourceStepId
            ? { feedbackSourceStepId: proposal.feedbackSourceStepId }
            : {}),
          ...(proposal.feedbackSourceInvocationId
            ? { feedbackSourceInvocationId: proposal.feedbackSourceInvocationId }
            : {}),
          ...(proposal.feedbackArtifactId
            ? { feedbackArtifactId: proposal.feedbackArtifactId }
            : {}),
          ...(proposal.qualityGateId
            ? { qualityGateId: proposal.qualityGateId }
            : {}),
          instruction: proposal.instruction,
          referencedArtifactIds: [...proposal.referencedArtifactIds],
        });
        await onTaskRunChanged();
      } catch (e) {
        setActionError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [onTaskRunChanged],
  );

  const runMarkReady = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await window.harness.quality.markReadyForReview({
        taskRunId: taskRun.id,
      });
      await onTaskRunChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [taskRun.id, onTaskRunChanged]);

  const runMarkDone = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      // markDone stamps the LearningTrace at the service layer so every
      // `done` TaskRun has a trace — the renderer no longer races a
      // separate best-effort recordOutcome call.
      await window.harness.quality.markDone({ taskRunId: taskRun.id });
      await onTaskRunChanged();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [taskRun.id, onTaskRunChanged]);

  const runApproveKnownRisks = useCallback(
    async (message: string) => {
      await window.harness.quality.approveKnownRisks({
        taskRunId: taskRun.id,
        message,
      });
      await fetchLatest();
      await onTaskRunChanged();
    },
    [taskRun.id, fetchLatest, onTaskRunChanged],
  );

  const gate = gateState.kind === "ready" ? gateState.gate : null;
  const status = gate?.status ?? "not_run";
  const knownRiskApproved = useMemo(() => {
    if (!gate) return false;
    return artifacts.some(
      (a) =>
        a.kind === "quality_report" &&
        typeof a.uri === "string" &&
        a.uri.endsWith(`/${gate.id}`),
    );
  }, [gate, artifacts]);
  const canMarkDone =
    !!gate &&
    taskRun.status === "ready_for_review" &&
    (gate.status === "passed" ||
      (gate.status === "warning" && knownRiskApproved));
  const repairRows = useMemo(
    () =>
      buildRepairAttemptRows({
        attempts: repairAttempts,
        qualityGates,
        approvals,
        artifacts,
      }),
    [approvals, artifacts, qualityGates, repairAttempts],
  );

  return (
    <div className="quality-panel">
      <header className="panel-header panel-header--inset">
        <span className="panel-header__title">
          Quality
          <FeatureHelpButton featureId="quality" />
        </span>
      </header>
      <div className="quality-panel__row">
        <span className={statusClass(status)}>{status}</span>
        <span className="muted">TaskRun status: {taskRun.status}</span>
      </div>

      {gateState.kind === "loading" ? (
        <div className="empty-state">불러오는 중…</div>
      ) : null}
      {gateState.kind === "error" ? (
        <div className="error-message">{gateState.message}</div>
      ) : null}

      <fieldset className="quality-panel__requires">
        <legend>요구 evidence</legend>
        <label>
          <input
            type="checkbox"
            checked={requireFlags.requireBuild}
            onChange={(e) =>
              setRequireFlags((s) => ({ ...s, requireBuild: e.target.checked }))
            }
          />
          build
        </label>
        <label>
          <input
            type="checkbox"
            checked={requireFlags.requireTests}
            onChange={(e) =>
              setRequireFlags((s) => ({ ...s, requireTests: e.target.checked }))
            }
          />
          tests
        </label>
        <label>
          <input
            type="checkbox"
            checked={requireFlags.requireSmoke}
            onChange={(e) =>
              setRequireFlags((s) => ({ ...s, requireSmoke: e.target.checked }))
            }
          />
          smoke
        </label>
      </fieldset>

      {gate ? (
        <ul className="quality-panel__metrics">
          <li>
            build: <strong>{formatBoolStatus(gate.buildPassed)}</strong>
          </li>
          <li>
            tests: <strong>{formatBoolStatus(gate.testsPassed)}</strong>
          </li>
          <li>
            smoke:{" "}
            <strong>
              {requireFlags.requireSmoke
                ? formatBoolStatus(gate.smokePassed)
                : "not required"}
            </strong>
          </li>
          <li>
            changed files reviewed:{" "}
            <strong>
              {gate.changedFilesReviewed === undefined
                ? "not run"
                : gate.changedFilesReviewed
                  ? "yes"
                  : "no"}
            </strong>
          </li>
        </ul>
      ) : (
        <div className="empty-state">
          아직 평가되지 않았습니다. 아래에서 evaluate를 실행하세요.
        </div>
      )}

      {gate && gate.knownRisks.length > 0 ? (
        <details className="quality-panel__risks" open>
          <summary>Known risks ({gate.knownRisks.length})</summary>
          <ul>
            {gate.knownRisks.map((risk, idx) => (
              <li key={idx}>{risk}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {gate && gate.evidenceArtifactIds.length > 0 ? (
        <details className="quality-panel__evidence">
          <summary>Evidence artifacts ({gate.evidenceArtifactIds.length})</summary>
          <ul>
            {gate.evidenceArtifactIds.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <RepairAttemptsSection rows={repairRows} />
      <A2ARefinementProposalsSection
        proposals={refinementProposals}
        busy={busy}
        onRequest={runRequestRefinement}
      />

      {actionError ? <div className="error-message">{actionError}</div> : null}

      <div className="quality-panel__actions">
        <button
          type="button"
          className="btn"
          onClick={() => void runEvaluate()}
          disabled={busy}
        >
          Evaluate
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void runRepair()}
          disabled={busy || !gate || gate.status === "passed"}
          title={
            gate?.status === "passed"
              ? "이미 통과한 게이트에는 repair plan이 필요 없습니다."
              : undefined
          }
        >
          Create repair plan
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setRiskDialogOpen(true)}
          disabled={
            busy ||
            !gate ||
            gate.status === "passed" ||
            gate.status === "failed" ||
            gate.status === "not_run"
          }
          title={
            !gate || gate.status === "not_run"
              ? "evaluate 결과가 필요합니다."
              : gate.status === "failed"
                ? "실패한 게이트는 repair 후에 승인할 수 있습니다."
                : undefined
          }
        >
          Approve known risks
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void runMarkReady()}
          disabled={
            busy ||
            !gate ||
            gate.status === "failed" ||
            gate.status === "not_run"
          }
        >
          Mark ready for review
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void runMarkDone()}
          disabled={busy || !canMarkDone}
          title={
            canMarkDone
              ? undefined
              : doneBlockedReason(taskRun.status, gate, knownRiskApproved)
          }
        >
          Mark done
        </button>
      </div>

      {riskDialogOpen && gate ? (
        <RiskApprovalDialog
          gate={gate}
          onClose={() => setRiskDialogOpen(false)}
          onApprove={runApproveKnownRisks}
        />
      ) : null}
    </div>
  );
};

const RepairAttemptsSection = ({
  rows,
}: {
  rows: RepairAttemptRow[];
}): JSX.Element => (
  <details className="quality-panel__repair" open={rows.length > 0}>
    <summary>Repair attempts ({rows.length})</summary>
    {rows.length === 0 ? (
      <div className="empty-state">repair attempt 기록이 없습니다.</div>
    ) : (
      <ol className="quality-panel__repair-list">
        {rows.map((row) => (
          <li key={row.attempt.id} className="quality-panel__repair-item">
            <div className="quality-panel__repair-head">
              <strong>Attempt {row.attemptNumber}</strong>
              <span className={repairStatusClass(row.attempt.status)}>
                {row.attempt.status}
              </span>
            </div>
            <dl className="quality-panel__repair-meta">
              <div>
                <dt>gate</dt>
                <dd>{row.gateStatus}</dd>
              </div>
              <div>
                <dt>approvals</dt>
                <dd>{row.generatedApprovals.length}</dd>
              </div>
              <div>
                <dt>diffs</dt>
                <dd>{row.diffArtifacts.length}</dd>
              </div>
            </dl>
            {row.generatedApprovals.length > 0 ? (
              <ul className="quality-panel__repair-links">
                {row.generatedApprovals.map((approval) => (
                  <li key={approval.id}>
                    <code>{approval.id}</code> {approval.actionSummary}
                  </li>
                ))}
              </ul>
            ) : null}
            {row.diffArtifacts.length > 0 ? (
              <ul className="quality-panel__repair-links">
                {row.diffArtifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <code>{artifact.id}</code> {artifact.title}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    )}
  </details>
);

const A2ARefinementProposalsSection = ({
  proposals,
  busy,
  onRequest,
}: {
  proposals: readonly A2ARefinementProposal[];
  busy: boolean;
  onRequest: (proposal: A2ARefinementProposal) => Promise<void>;
}): JSX.Element | null => {
  if (proposals.length === 0) return null;
  return (
    <details className="quality-panel__repair" open>
      <summary>Targeted A2A refinements ({proposals.length})</summary>
      <ol className="quality-panel__repair-list">
        {proposals.map((proposal) => (
          <li key={proposal.id} className="quality-panel__repair-item">
            <div className="quality-panel__repair-head">
              <strong>{proposal.sourceLabel}</strong>
              <span className="status-pill status-pill--warning">
                {proposal.sourceKind}
              </span>
            </div>
            <dl className="quality-panel__repair-meta">
              <div>
                <dt>target</dt>
                <dd>{proposal.targetLabel}</dd>
              </div>
              <div>
                <dt>artifacts</dt>
                <dd>{proposal.referencedArtifactIds.length}</dd>
              </div>
              <div>
                <dt>source</dt>
                <dd>{proposal.feedbackSourceKind}</dd>
              </div>
            </dl>
            <p className="muted">{proposal.reason}</p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void onRequest(proposal)}
            >
              Request refinement
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
};

const repairStatusClass = (status: RepairAttempt["status"]): string => {
  if (status === "passed") return "status-pill status-pill--passed";
  if (status === "failed" || status === "stopped")
    return "status-pill status-pill--failed";
  if (status === "executed") return "status-pill status-pill--warning";
  return "status-pill status-pill--neutral";
};

const doneBlockedReason = (
  status: string,
  gate: { status: string } | null,
  knownRiskApproved: boolean,
): string => {
  if (!gate) return "Quality gate를 먼저 평가하세요.";
  if (gate.status === "failed") return "Quality gate가 failed입니다. 먼저 repair plan을 통해 수정하세요.";
  if (gate.status === "not_run") return "Quality gate에 evidence가 없습니다. evaluate를 다시 실행하세요.";
  if (gate.status === "warning" && !knownRiskApproved)
    return "Warning 상태입니다. Approve known risks 후에만 done이 가능합니다.";
  if (status !== "ready_for_review")
    return `TaskRun이 ready_for_review여야 합니다 (현재: ${status}).`;
  return "Mark done을 사용할 수 없습니다.";
};
