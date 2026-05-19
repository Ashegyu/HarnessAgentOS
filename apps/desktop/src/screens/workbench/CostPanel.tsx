import { useEffect, useMemo, useState } from "react";
import type {
  TaskRunCostBudgetProgress,
  TaskRunCostModelBreakdown,
  TaskRunCostSummary,
} from "@harness/core";
import {
  budgetProgressPercent,
  budgetProgressTone,
  hasCostData,
  visibleBudgetProgress,
} from "./cost-panel-model";

interface CostPanelProps {
  taskRunId: string;
}

type CostState =
  | { kind: "loading" }
  | { kind: "ready"; summary: TaskRunCostSummary }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const numberFormat = new Intl.NumberFormat();

const formatUsd = (value: number): string =>
  value === 0 ? "$0.00" : `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const formatTokens = (value: number): string =>
  numberFormat.format(Math.round(value));

const formatKnownTokens = (
  value: number | undefined,
  unknownCount = 0,
  approximate = false,
): string => {
  if (value === undefined) return "Unknown";
  const suffix = [approximate ? "approx." : "", unknownCount > 0 ? "known" : ""]
    .filter(Boolean)
    .join(" ");
  return suffix.length > 0
    ? `${formatTokens(value)} tokens ${suffix}`
    : `${formatTokens(value)} tokens`;
};

const unknownTokenNotice = (count: number): string =>
  count === 1
    ? "1 call has unknown token usage"
    : `${count} calls have unknown token usage`;

const formatDuration = (ms: number): string => {
  if (ms <= 0) return "0ms";
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
};

const statusClass = (success: boolean | undefined): string => {
  if (success === true) return "status-pill status-pill--passed";
  if (success === false) return "status-pill status-pill--failed";
  return "status-pill status-pill--neutral";
};

const statusLabel = (success: boolean | undefined): string => {
  if (success === true) return "success";
  if (success === false) return "failed";
  return "unknown";
};

export const CostPanel = ({ taskRunId }: CostPanelProps): JSX.Element => {
  const [state, setState] = useState<CostState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    window.harness.learner
      .summarizeTaskRunCost({ taskRunId })
      .then((summary) => {
        if (!cancelled) setState({ kind: "ready", summary });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [taskRunId]);

  if (state.kind === "loading") {
    return <div className="empty-state">사용량 요약을 불러오는 중...</div>;
  }

  if (state.kind === "error") {
    return <div className="error-message">{state.message}</div>;
  }

  return <CostSummaryView summary={state.summary} />;
};

export const CostSummaryView = ({
  summary,
}: {
  summary: TaskRunCostSummary;
}): JSX.Element => {
  const budgetRows = visibleBudgetProgress(summary);
  const statusCounts = summary.agentInvocationStatusCounts;
  const unknownTokenCount = taskRunUnknownTokenCount(summary);
  const maxModelTokens = useMemo(
    () => Math.max(0, ...summary.perModel.map((item) => item.totalTokens ?? 0)),
    [summary.perModel],
  );

  return (
    <section className="cost-panel" aria-label="Usage summary">
      <header className="panel-header panel-header--inset">
        <span className="panel-header__title">Usage</span>
      </header>
      <div className="cost-panel__body">
        <dl className="cost-panel__metrics">
          <div>
            <dt>Total tokens</dt>
            <dd>
              {formatKnownTokens(
                summary.totalTokens,
                unknownTokenCount,
                hasApproximateUsage(summary.invocations),
              )}
            </dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>{formatDuration(summary.totalLatencyMs)}</dd>
          </div>
          <div>
            <dt>Trace count</dt>
            <dd>{summary.invocationCount}</dd>
          </div>
          <div>
            <dt>Agent calls</dt>
            <dd>{formatStatusCounts(statusCounts)}</dd>
          </div>
        </dl>

        {unknownTokenCount > 0 ? (
          <div className="empty-state">{unknownTokenNotice(unknownTokenCount)}.</div>
        ) : null}

        {budgetRows.length > 0 ? (
          <BudgetProgress
            profileName={summary.budget?.profileName ?? "Agent Profile"}
            rows={budgetRows}
          />
        ) : null}

        {!hasCostData(summary) ? (
          <div className="empty-state">아직 사용량 trace가 없습니다.</div>
        ) : null}

        {summary.perModel.length > 0 ? (
          <ModelBreakdownChart
            items={summary.perModel}
            maxTokens={maxModelTokens}
          />
        ) : null}

        <InvocationTable summary={summary} />
      </div>
    </section>
  );
};

const BudgetProgress = ({
  profileName,
  rows,
}: {
  profileName: string;
  rows: TaskRunCostBudgetProgress[];
}): JSX.Element => (
  <section className="cost-panel__budget" aria-label="Budget progress">
    <div className="cost-panel__section-head">
      <h4>Budget</h4>
      <span>{profileName}</span>
    </div>
    <div className="cost-panel__budget-list">
      {rows.map((row) => {
        const tone = budgetProgressTone(row);
        return (
          <div className="cost-panel__budget-row" key={row.scope}>
            <div className="cost-panel__budget-label">
              <span>{row.label}</span>
              <strong>
                {formatUsd(row.usedUsd)} / {formatUsd(row.limitUsd)}
              </strong>
            </div>
            <div
              className="cost-panel__budget-track"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={budgetProgressPercent(row)}
              aria-label={`${row.label} budget`}
            >
              <div
                className={`cost-panel__budget-fill cost-panel__budget-fill--${tone}`}
                style={{ width: `${budgetProgressPercent(row)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  </section>
);

const ModelBreakdownChart = ({
  items,
  maxTokens,
}: {
  items: TaskRunCostModelBreakdown[];
  maxTokens: number;
}): JSX.Element => {
  const rowHeight = 28;
  const height = Math.max(44, items.length * rowHeight + 12);
  return (
    <section className="cost-panel__models" aria-label="Model token breakdown">
      <div className="cost-panel__section-head">
        <h4>Model breakdown</h4>
        <span>{items.length} models</span>
      </div>
      <svg
        className="cost-panel__chart"
        viewBox={`0 0 100 ${height}`}
        role="img"
        aria-label="Tokens by model"
        preserveAspectRatio="none"
      >
        {items.map((item, index) => {
          const y = index * rowHeight + 8;
          const width = maxModelBarWidth(item.totalTokens ?? 0, maxTokens);
          return (
            <g key={item.model}>
              <rect
                x="0"
                y={y}
                width={width}
                height="14"
                rx="2"
                className="cost-panel__chart-bar"
              />
            </g>
          );
        })}
      </svg>
      <ul className="cost-panel__model-list">
        {items.map((item) => (
          <li key={item.model}>
            <span>{item.model}</span>
            <strong>
              {formatKnownTokens(
                item.totalTokens,
                modelUnknownTokenCount(item),
              )} ·{" "}
              {item.count} calls ·{" "}
              {formatDuration(item.latencyMs)}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
};

const InvocationTable = ({
  summary,
}: {
  summary: TaskRunCostSummary;
}): JSX.Element => (
  <section className="cost-panel__table-section" aria-label="Invocation usage">
    <div className="cost-panel__section-head">
      <h4>Invocations</h4>
      <span>{summary.invocations.length} rows</span>
    </div>
    {summary.invocations.length === 0 ? (
      <div className="empty-state">표시할 invocation 사용량 기록이 없습니다.</div>
    ) : (
      <div className="cost-panel__table-wrap">
        <table className="cost-panel__table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Tokens</th>
              <th>Latency</th>
              <th>Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {summary.invocations.map((item) => (
              <tr key={item.id}>
                <td>{item.model}</td>
                <td>{formatInvocationTokens(item)}</td>
                <td>{formatDuration(item.latencyMs)}</td>
                <td>
                  <span className={statusClass(item.success)}>
                    {statusLabel(item.success)}
                  </span>
                </td>
                <td>{formatTimestamp(item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

const taskRunUnknownTokenCount = (summary: TaskRunCostSummary): number =>
  summary.unknownTokenInvocationCount ??
  (summary.invocationCount > 0 && summary.totalTokens === undefined
    ? summary.invocationCount
    : 0);

const modelUnknownTokenCount = (item: TaskRunCostModelBreakdown): number =>
  item.unknownTokenInvocationCount ??
  (item.count > 0 && item.totalTokens === undefined ? item.count : 0);

const hasApproximateUsage = (
  invocations: TaskRunCostSummary["invocations"],
): boolean => invocations.some((item) => item.usageApproximate === true);

const formatInvocationTokens = (
  item: TaskRunCostSummary["invocations"][number],
): string => {
  if (item.totalTokens === undefined) return "Unknown";
  const parts = [`${formatTokens(item.totalTokens)} tokens`];
  if (item.inputTokens !== undefined || item.outputTokens !== undefined) {
    parts.push(
      `(in ${formatTokens(item.inputTokens ?? 0)} / out ${formatTokens(
        item.outputTokens ?? 0,
      )})`,
    );
  }
  if (item.usageApproximate) parts.push("approx.");
  return parts.join(" ");
};

const maxModelBarWidth = (tokens: number, maxTokens: number): number =>
  maxTokens > 0 ? Math.max(2, (tokens / maxTokens) * 100) : 0;

const formatStatusCounts = (
  counts: TaskRunCostSummary["agentInvocationStatusCounts"],
): string => {
  if (!counts) return "0";
  const completed = counts.succeeded + counts.failed + counts.cancelled;
  const active = counts.queued + counts.running;
  return active > 0 ? `${completed} done / ${active} active` : `${completed}`;
};

const formatTimestamp = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
};
