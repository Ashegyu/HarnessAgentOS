import { useEffect, useMemo, useState } from "react";
import {
  APPROVAL_ACTION_TYPES,
  AUTO_APPROVE_STEPS,
  type A2ARefinementActivityPage,
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

const A2A_REFINEMENT_ACTIVITY_PAGE_SIZE = 25;

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
  const [a2aState, setA2AState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; page: A2ARefinementActivityPage }
    | { kind: "error"; message: string }
    | { kind: "skipped" }
  >({ kind: "loading" });

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

  useEffect(() => {
    let cancelled = false;
    if (actionType !== "all" && actionType !== "network") {
      setA2AState({ kind: "skipped" });
      return () => {
        cancelled = true;
      };
    }
    setA2AState({ kind: "loading" });
    window.harness.conversation
      .listRefinementEvents({
        limit: A2A_REFINEMENT_ACTIVITY_PAGE_SIZE,
        offset: 0,
        ...(filter?.sinceIso ? { sinceIso: filter.sinceIso } : {}),
        ...(filter?.untilIso ? { untilIso: filter.untilIso } : {}),
      })
      .then((page) => {
        if (!cancelled) setA2AState({ kind: "ready", page });
      })
      .catch((error) => {
        if (!cancelled) {
          setA2AState({ kind: "error", message: errorMessage(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [actionType, filter?.sinceIso, filter?.untilIso, refreshTick]);

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
  const a2aPage = a2aState.kind === "ready" ? a2aState.page : null;
  const pageNumber = Math.floor(offset / ACTIVITY_LOG_PAGE_SIZE) + 1;

  return (
    <div className="activity-log">
      <header className="activity-log__toolbar">
        <div>
          <h3>Activity Log</h3>
          <span>
            {page ? `${page.total} decisions` : "decision audit"}
            {a2aPage ? ` · ${a2aPage.total} A2A events` : ""}
          </span>
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

      {a2aState.kind === "loading" ? (
        <div className="empty-state">A2A refinement events 불러오는 중...</div>
      ) : null}
      {a2aState.kind === "error" ? (
        <div className="empty-state" style={{ color: "var(--status-failed)" }}>
          {a2aState.message}
        </div>
      ) : null}
      {a2aPage && a2aPage.items.length > 0 ? (
        <A2ARefinementEventsTable page={a2aPage} />
      ) : null}

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

export const A2ARefinementEventsTable = ({
  page,
}: {
  page: A2ARefinementActivityPage;
}): JSX.Element | null => {
  if (page.items.length === 0) return null;
  return (
    <section
      className="activity-log__a2a-events"
      aria-label="A2A Refinement Events"
    >
      <header className="activity-log__section-header">
        <h4>A2A Refinement Events</h4>
        <span>{page.total} events</span>
      </header>
      <div className="activity-log__table-wrap">
        <table className="activity-log__table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Endpoint</th>
              <th>Context</th>
              <th>Attempt</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((event) => (
              <tr key={event.id}>
                <td>{formatTimestamp(event.createdAt)}</td>
                <td>
                  <strong>{event.eventType}</strong>
                  <span>{event.summary}</span>
                </td>
                <td>
                  <strong>{event.endpointId}</strong>
                  <span>{event.targetInvocationId}</span>
                </td>
                <td>
                  <strong>{event.parentRemoteContextId ?? "none"}</strong>
                  <span>{event.remoteContextId ?? event.parentRemoteTaskId ?? ""}</span>
                </td>
                <td>
                  <strong>attempt {event.attemptIndex + 1}</strong>
                  <span>{event.status}</span>
                </td>
                <td>
                  <strong>{event.feedbackSourceKind}</strong>
                  <span>{event.stopReason ?? ""}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
