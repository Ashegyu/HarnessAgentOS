import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Approval,
  OrchestrationMode,
  OrchestrationPlan,
  OrchestrationRunResult,
  TaskRun,
} from "@harness/core";
import { WorkerStepView } from "./WorkerStepView";

interface OrchestrationPanelProps {
  taskRun: TaskRun | null;
  approvals: Approval[];
  onRefreshTaskRun: () => Promise<void>;
}

type PlanState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; plan: OrchestrationPlan | null }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const MODES: { value: OrchestrationMode; label: string }[] = [
  { value: "single_worker", label: "single_worker" },
  { value: "planner_worker", label: "planner_worker" },
  { value: "multi_worker", label: "multi_worker" },
];

const isRunnable = (a: Approval): boolean =>
  a.actionType === "orchestration_plan" &&
  (a.status === "approved" || a.status === "always_approved_for_run");

const isPendingPlanApproval = (a: Approval): boolean =>
  a.actionType === "orchestration_plan" && a.status === "pending";

export const OrchestrationPanel = ({
  taskRun,
  approvals,
  onRefreshTaskRun,
}: OrchestrationPanelProps): JSX.Element => {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [orchEnabled, setOrchEnabled] = useState<boolean | null>(null);
  const [planState, setPlanState] = useState<PlanState>({ kind: "idle" });
  const [mode, setMode] = useState<OrchestrationMode>("single_worker");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<OrchestrationRunResult | null>(null);

  const runnableApprovals = useMemo(
    () => approvals.filter(isRunnable),
    [approvals],
  );
  const pendingPlanApproval = useMemo(
    () => approvals.find(isPendingPlanApproval) ?? null,
    [approvals],
  );

  const refreshOrchEnabled = useCallback(async (): Promise<void> => {
    try {
      const s = await window.harness.settings.get();
      setOrchEnabled(s.orchestration.enabled);
    } catch {
      setOrchEnabled(false);
    }
  }, []);

  const fetchPlan = useCallback(async (): Promise<void> => {
    if (!taskRun) {
      setPlanState({ kind: "idle" });
      return;
    }
    setPlanState({ kind: "loading" });
    try {
      const plan = await window.harness.orchestration.getPlan({
        taskRunId: taskRun.id,
      });
      setPlanState({ kind: "ready", plan });
    } catch (e) {
      setPlanState({ kind: "error", message: errorMessage(e) });
    }
  }, [taskRun]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.harness.settings.get();
        setOrchEnabled(s.orchestration.enabled);
        setMode(s.orchestration.defaultMode);
        if (s.orchestration.defaultInstructions) {
          setInstruction(s.orchestration.defaultInstructions);
        }
      } catch {
        setOrchEnabled(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!advancedOpen) return;
    void fetchPlan();
  }, [advancedOpen, fetchPlan]);

  const handleDraft = useCallback(async (): Promise<void> => {
    if (!taskRun) return;
    setBusy(true);
    setActionError(null);
    try {
      await window.harness.orchestration.draftPlan({
        taskRunId: taskRun.id,
        mode,
        ...(instruction.trim().length > 0
          ? { instruction: instruction.trim() }
          : {}),
      });
      await fetchPlan();
      await onRefreshTaskRun();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [taskRun, mode, instruction, fetchPlan, onRefreshTaskRun]);

  const handleRun = useCallback(
    async (approvalId: string): Promise<void> => {
      setRunningId(approvalId);
      setActionError(null);
      setLastRun(null);
      try {
        const result = await window.harness.orchestration.runApproved({
          approvalId,
        });
        setLastRun(result);
        await fetchPlan();
        await onRefreshTaskRun();
      } catch (e) {
        setActionError(errorMessage(e));
      } finally {
        setRunningId(null);
      }
    },
    [fetchPlan, onRefreshTaskRun],
  );

  if (!taskRun) {
    return <div className="empty-state">TaskRun을 선택하세요.</div>;
  }

  return (
    <div className="orchestration-panel">
      <label className="orchestration-panel__toggle">
        <input
          type="checkbox"
          checked={advancedOpen}
          onChange={(e) => setAdvancedOpen(e.target.checked)}
        />
        <span>고급: agent orchestration</span>
      </label>
      {!advancedOpen ? (
        <p className="muted">
          기본 경로에서는 비활성화되어 있습니다. 활성화 시 plan/checkpoint/quality gate를
          그대로 따릅니다.
        </p>
      ) : null}
      {advancedOpen ? (
        <>
          {orchEnabled === false && (
            <div className="orchestration-panel__disabled-notice">
              Orchestration이 비활성화되어 있습니다.{" "}
              <strong>설정 &gt; Orchestration 활성화</strong>를 켠 후 저장한 다음{" "}
              <button
                type="button"
                className="orchestration-panel__refresh-btn"
                onClick={() => void refreshOrchEnabled()}
              >
                새로고침
              </button>
              하세요.
            </div>
          )}
          <div className="orchestration-panel__form">
            <label className="form-field">
              <span>Mode</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as OrchestrationMode)}
                className="textarea"
                disabled={busy}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Instruction (선택)</span>
              <input
                type="text"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                className="textarea"
                placeholder="planner에게 전달할 지시 (선택)"
                disabled={busy}
              />
            </label>
            <div className="orchestration-panel__actions">
              <button
                type="button"
                className="btn"
                onClick={() => void handleDraft()}
                disabled={busy || orchEnabled === false}
              >
                {busy ? "처리 중…" : "Plan 초안 작성 (approval 생성)"}
              </button>
            </div>
            {actionError ? (
              <div className="error-message">{actionError}</div>
            ) : null}
          </div>

          {planState.kind === "loading" ? (
            <div className="empty-state">불러오는 중…</div>
          ) : null}
          {planState.kind === "error" ? (
            <div className="error-message">{planState.message}</div>
          ) : null}
          {planState.kind === "ready" && planState.plan ? (
            <section className="orchestration-panel__plan">
              <header className="orchestration-panel__plan-header">
                <span>Plan: {planState.plan.mode}</span>
                <span className="muted">
                  {planState.plan.workerSteps.length} steps · approval required
                </span>
              </header>
              <ul className="orchestration-panel__steps">
                {planState.plan.workerSteps.map((s) => (
                  <WorkerStepView key={s.id} step={s} />
                ))}
              </ul>
            </section>
          ) : planState.kind === "ready" ? (
            <div className="empty-state">
              아직 orchestration plan이 없습니다. 위에서 mode를 선택하고 초안을 작성하세요.
            </div>
          ) : null}

          <section className="orchestration-panel__run">
            <header className="orchestration-panel__plan-header">
              <span>승인된 plan 실행</span>
              <span className="muted">
                {runnableApprovals.length} approved · {pendingPlanApproval ? "1 pending" : "0 pending"}
              </span>
            </header>
            {pendingPlanApproval ? (
              <p className="muted">
                Approvals 패널에서 plan approval(<code>{pendingPlanApproval.id}</code>)을
                먼저 승인하세요.
              </p>
            ) : null}
            {runnableApprovals.length === 0 ? (
              <div className="empty-state">
                승인된 orchestration plan이 없습니다.
              </div>
            ) : (
              <ul className="orchestration-panel__approvals">
                {runnableApprovals.map((a) => (
                  <li key={a.id} className="orchestration-panel__approval">
                    <div className="orchestration-panel__approval-info">
                      <code>{a.id}</code>
                      <span className="muted">{a.actionSummary}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void handleRun(a.id)}
                      disabled={runningId !== null}
                    >
                      {runningId === a.id ? "실행 중…" : "Worker 실행"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {lastRun ? (
              <div className="orchestration-panel__last-run">
                <p className="muted">
                  실행 완료 — {lastRun.workerSteps.length} step,{" "}
                  {lastRun.workerStepArtifactIds.length} artifact
                </p>
                <ul className="orchestration-panel__steps">
                  {lastRun.workerSteps.map((s) => (
                    <WorkerStepView key={s.id} step={s} />
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
};
