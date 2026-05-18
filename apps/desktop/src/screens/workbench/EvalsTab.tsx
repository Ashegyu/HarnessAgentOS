import { useCallback, useEffect, useState } from "react";
import type {
  EvalRunCaseView,
  EvalRunDetailView,
  EvalRunListItem,
} from "@harness/core";

type RunsState =
  | { kind: "loading" }
  | { kind: "ready"; runs: EvalRunListItem[] }
  | { kind: "error"; message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const numberFormat = new Intl.NumberFormat(undefined);
const percentFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const formatDuration = (durationMs: number): string => {
  const ms = finite(durationMs);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
};

const formatTokens = (tokens: number): string =>
  numberFormat.format(Math.round(finite(tokens)));

const formatPercent = (ratio: number): string =>
  `${percentFormat.format(finite(ratio) * 100)}%`;

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

const runLabel = (run: EvalRunListItem): string =>
  `${run.suite}${run.mode ? ` / ${run.mode}` : ""}`;

const providerLabel = (caseView: EvalRunCaseView): string =>
  caseView.provider ?? "-";

export const EvalsTab = (): JSX.Element => {
  const [runsState, setRunsState] = useState<RunsState>({ kind: "loading" });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EvalRunDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    setRunsState({ kind: "loading" });
    try {
      const runs = await window.harness.evals.listRuns({ limit: 50 });
      setRunsState({ kind: "ready", runs });
      setSelectedRunId((current) =>
        current && runs.some((run) => run.id === current)
          ? current
          : (runs[0]?.id ?? null),
      );
    } catch (error) {
      setRunsState({ kind: "error", message: errorMessage(error) });
      setSelectedRunId(null);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void window.harness.evals
      .getRun({ runId: selectedRunId })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  return (
    <div className="evals-tab">
      <aside className="evals-tab__list">
        <header className="evals-tab__list-header">
          <span>Runs</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void loadRuns()}
            disabled={runsState.kind === "loading"}
          >
            Refresh
          </button>
        </header>

        {runsState.kind === "loading" && (
          <div className="empty-state">불러오는 중...</div>
        )}
        {runsState.kind === "error" && (
          <div className="empty-state" style={{ color: "var(--status-failed)" }}>
            {runsState.message}
          </div>
        )}
        {runsState.kind === "ready" && runsState.runs.length === 0 && (
          <div className="empty-state">기록된 eval run이 없습니다.</div>
        )}
        {runsState.kind === "ready" && runsState.runs.length > 0 && (
          <ul className="evals-tab__items">
            {runsState.runs.map((run) => {
              const selected = run.id === selectedRunId;
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    className={`evals-tab__item${
                      selected ? " evals-tab__item--selected" : ""
                    }`}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <span className="evals-tab__item-title">
                      {runLabel(run)}
                    </span>
                    <span className="evals-tab__item-meta">
                      {formatTimestamp(run.startedAt)} · {run.status}
                    </span>
                    <span className="evals-tab__item-metrics">
                      {formatPercent(run.passRate)} · {run.attemptCount} attempts ·{" "}
                      {formatDuration(run.totalDurationMs)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="evals-tab__detail">
        {detailLoading && <div className="empty-state">불러오는 중...</div>}
        {!detailLoading && detailError && (
          <div className="empty-state" style={{ color: "var(--status-failed)" }}>
            {detailError}
          </div>
        )}
        {!detailLoading && !detailError && !detail && (
          <div className="empty-state">run을 선택하세요.</div>
        )}
        {!detailLoading && !detailError && detail && (
          <div className="evals-tab__detail-body">
            <header className="evals-tab__detail-header">
              <div>
                <h3>{runLabel(detail.run)}</h3>
                <span>{detail.run.id}</span>
              </div>
              <span
                className={`evals-tab__status evals-tab__status--${detail.run.status}`}
              >
                {detail.run.status}
              </span>
            </header>

            <dl className="evals-tab__metrics">
              <div>
                <dt>Pass rate</dt>
                <dd>{formatPercent(detail.run.passRate)}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>
                  {detail.run.passedAttempts}/{detail.run.attemptCount}
                </dd>
              </div>
              <div>
                <dt>Cases</dt>
                <dd>{numberFormat.format(detail.run.caseCount)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(detail.run.totalDurationMs)}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>{formatTokens(detail.run.totalTokens)}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{detail.run.harnessSha?.slice(0, 12) ?? "-"}</dd>
              </div>
            </dl>

            <div className="evals-tab__table-wrap">
              <table className="evals-tab__table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Suite</th>
                    <th>Provider</th>
                    <th>Outcome</th>
                    <th>Attempts</th>
                    <th>Pass@3</th>
                    <th>Pass^3</th>
                    <th>Tokens</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.cases.map((caseView) => (
                    <tr key={`${caseView.caseId}:${providerLabel(caseView)}`}>
                      <td>
                        <span className="evals-tab__case-title">
                          {caseView.title || caseView.caseId}
                        </span>
                        <span className="evals-tab__case-id">
                          {caseView.caseId}
                        </span>
                      </td>
                      <td>{caseView.suite}</td>
                      <td>{providerLabel(caseView)}</td>
                      <td>{caseView.outcome}</td>
                      <td>
                        {caseView.passedAttempts}/{caseView.attemptCount}
                      </td>
                      <td>{formatPercent(caseView.passAt3)}</td>
                      <td>{formatPercent(caseView.passToThe3)}</td>
                      <td>{formatTokens(caseView.totalTokens)}</td>
                      <td>{formatDuration(caseView.totalDurationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
