import { useCallback, useEffect, useMemo, useState } from "react";
import type { Artifact, QualityGateResult, TaskRun } from "@harness/core";
import { RiskApprovalDialog } from "./RiskApprovalDialog";
import { FeatureHelpButton } from "./FeatureHelpButton";

interface QualityPanelProps {
  taskRun: TaskRun;
  artifacts: Artifact[];
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
