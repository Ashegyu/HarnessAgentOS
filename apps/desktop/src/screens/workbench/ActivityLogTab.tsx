import { useEffect, useMemo, useState } from "react";
import {
  APPROVAL_ACTION_TYPES,
  AUTO_APPROVE_STEPS,
  type ApprovalActionType,
  type AutoApproveStep,
  type DecisionLogPage,
} from "@harness/core";
import { AUTO_APPROVE_STEP_LABELS } from "./ApprovalDecisionTrace";
import {
  ACTIVITY_LOG_PAGE_SIZE,
  buildActivityLogFilter,
  nextDecisionOffset,
  previousDecisionOffset,
} from "./activity-log-model";

type ActivityState =
  | { kind: "loading" }
  | { kind: "ready"; page: DecisionLogPage }
  | { kind: "error"; message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const ActivityLogTab = (): JSX.Element => {
  const [selectedSteps, setSelectedSteps] = useState<ReadonlySet<AutoApproveStep>>(
    () => new Set(AUTO_APPROVE_STEPS),
  );
  const [actionType, setActionType] = useState<ApprovalActionType | "all">(
    "all",
  );
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [offset, setOffset] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [state, setState] = useState<ActivityState>({ kind: "loading" });

  const filter = useMemo(
    () =>
      buildActivityLogFilter({
        selectedSteps,
        actionType,
        fromDate,
        toDate,
      }),
    [actionType, fromDate, selectedSteps, toDate],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    window.harness.conversation
      .listDecisions({
        limit: ACTIVITY_LOG_PAGE_SIZE,
        offset,
        ...(filter ? { filter } : {}),
      })
      .then((page) => {
        if (!cancelled) setState({ kind: "ready", page });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filter, offset, refreshTick]);

  const resetPage = (): void => setOffset(0);

  const toggleStep = (step: AutoApproveStep): void => {
    setSelectedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
    resetPage();
  };

  const page = state.kind === "ready" ? state.page : null;
  const pageNumber = Math.floor(offset / ACTIVITY_LOG_PAGE_SIZE) + 1;

  return (
    <div className="activity-log">
      <header className="activity-log__toolbar">
        <div>
          <h3>Activity Log</h3>
          <span>{page ? `${page.total} decisions` : "decision audit"}</span>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setRefreshTick((value) => value + 1)}
          disabled={state.kind === "loading"}
        >
          Refresh
        </button>
      </header>

      <section className="activity-log__filters" aria-label="Activity filters">
        <div className="activity-log__step-filters" aria-label="Decision steps">
          {AUTO_APPROVE_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={
                selectedSteps.has(step)
                  ? "activity-log__filter activity-log__filter--active"
                  : "activity-log__filter"
              }
              aria-pressed={selectedSteps.has(step)}
              onClick={() => toggleStep(step)}
            >
              {AUTO_APPROVE_STEP_LABELS[step]}
            </button>
          ))}
        </div>
        <label className="activity-log__field">
          <span>Action</span>
          <select
            className="settings-field__input"
            value={actionType}
            onChange={(event) => {
              setActionType(event.target.value as ApprovalActionType | "all");
              resetPage();
            }}
          >
            <option value="all">All actions</option>
            {APPROVAL_ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-log__field">
          <span>From</span>
          <input
            className="settings-field__input"
            type="date"
            value={fromDate}
            onChange={(event) => {
              setFromDate(event.target.value);
              resetPage();
            }}
          />
        </label>
        <label className="activity-log__field">
          <span>To</span>
          <input
            className="settings-field__input"
            type="date"
            value={toDate}
            onChange={(event) => {
              setToDate(event.target.value);
              resetPage();
            }}
          />
        </label>
      </section>

      {state.kind === "loading" ? (
        <div className="empty-state">결정 로그를 불러오는 중...</div>
      ) : null}
      {state.kind === "error" ? (
        <div className="empty-state" style={{ color: "var(--status-failed)" }}>
          {state.message}
        </div>
      ) : null}
      {page && page.items.length === 0 ? (
        <div className="empty-state">조건에 맞는 decision trace가 없습니다.</div>
      ) : null}
      {page && page.items.length > 0 ? (
        <>
          <div className="activity-log__table-wrap">
            <table className="activity-log__table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Decision</th>
                  <th>Step</th>
                  <th>Action</th>
                  <th>Thread</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.approval.id}>
                    <td>{formatTimestamp(item.approval.decidedAt)}</td>
                    <td>
                      <span
                        className={
                          item.approval.autoApproveDecision.approved
                            ? "status-pill status-pill--passed"
                            : "status-pill status-pill--failed"
                        }
                      >
                        {item.approval.autoApproveDecision.approved
                          ? "approved"
                          : "blocked"}
                      </span>
                    </td>
                    <td>
                      {
                        AUTO_APPROVE_STEP_LABELS[
                          item.approval.autoApproveDecision.decidedAt
                        ]
                      }
                    </td>
                    <td>
                      <strong>{item.approval.actionType}</strong>
                      <span>{item.approval.actionSummary}</span>
                    </td>
                    <td>
                      <strong>{item.threadTitle}</strong>
                      <span>{item.taskRunUserRequest}</span>
                    </td>
                    <td>{item.approval.autoApproveDecision.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="activity-log__pager">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setOffset((value) => previousDecisionOffset(value))}
              disabled={offset === 0 || state.kind === "loading"}
            >
              Previous
            </button>
            <span>Page {pageNumber}</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setOffset((value) => nextDecisionOffset(value))}
              disabled={!page.hasNext || state.kind === "loading"}
            >
              Next
            </button>
          </footer>
        </>
      ) : null}
    </div>
  );
};

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};
