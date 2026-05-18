import { useMemo, useState } from "react";
import {
  AUTO_APPROVE_STEPS,
  type Approval,
  type AutoApproveStep,
} from "@harness/core";
import {
  buildDecisionTimelineRows,
  filterDecisionRows,
} from "./decisions-panel-model";
import { AUTO_APPROVE_STEP_LABELS } from "./ApprovalDecisionTrace";

interface DecisionsPanelProps {
  approvals: Approval[];
  onJumpToApproval: (approvalId: string) => void;
}

export const DecisionsPanel = ({
  approvals,
  onJumpToApproval,
}: DecisionsPanelProps): JSX.Element => {
  const allRows = useMemo(
    () => buildDecisionTimelineRows(approvals),
    [approvals],
  );
  const [selectedSteps, setSelectedSteps] = useState<ReadonlySet<AutoApproveStep>>(
    () => new Set(AUTO_APPROVE_STEPS),
  );
  const visibleRows = useMemo(
    () => filterDecisionRows(allRows, selectedSteps),
    [allRows, selectedSteps],
  );

  const toggleStep = (step: AutoApproveStep): void => {
    setSelectedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  };

  return (
    <section className="decisions-panel" aria-label="Auto approval decisions">
      <header className="panel-header panel-header--inset">
        <span className="panel-header__title">Decisions</span>
      </header>
      <div className="decisions-panel__body">
        <div className="decisions-panel__filters" aria-label="Decision step filters">
          {AUTO_APPROVE_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={
                selectedSteps.has(step)
                  ? "decisions-panel__filter decisions-panel__filter--active"
                  : "decisions-panel__filter"
              }
              aria-pressed={selectedSteps.has(step)}
              onClick={() => toggleStep(step)}
            >
              {AUTO_APPROVE_STEP_LABELS[step]}
            </button>
          ))}
        </div>

        {allRows.length === 0 ? (
          <div className="empty-state">자동 승인 decision trace가 없습니다.</div>
        ) : null}

        {allRows.length > 0 && visibleRows.length === 0 ? (
          <div className="empty-state">선택한 단계에 해당하는 decision이 없습니다.</div>
        ) : null}

        {visibleRows.length > 0 ? (
          <ol className="decisions-panel__timeline">
            {visibleRows.map((row) => (
              <li
                key={row.approvalId}
                className={
                  row.approved
                    ? "decisions-panel__row decisions-panel__row--approved"
                    : "decisions-panel__row decisions-panel__row--blocked"
                }
              >
                <div className="decisions-panel__row-head">
                  <time>{formatTime(row.timeIso)}</time>
                  <span
                    className={
                      row.approved
                        ? "status-pill status-pill--passed"
                        : "status-pill status-pill--failed"
                    }
                  >
                    {row.approved ? "approved" : "blocked"}
                  </span>
                </div>
                <div className="decisions-panel__row-main">
                  <strong>{row.decidedAtLabel}</strong>
                  <span>{row.actionType}</span>
                </div>
                <p>{row.reason}</p>
                <div className="decisions-panel__row-foot">
                  <span>{row.actionSummary}</span>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onJumpToApproval(row.approvalId)}
                  >
                    Approval
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
};

const formatTime = (iso: string | undefined): string => {
  if (!iso) return "time pending";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};
