import { useEffect, useMemo, useState } from "react";
import type {
  AgentBudget,
  BudgetUsageProfileSummary,
  BudgetUsageSummary,
} from "@harness/core";
import {
  budgetUsageTone,
  dailyBudgetPercent,
  isBudgetUsageEmpty,
  maxDailyProfileCost,
} from "./budget-overview-model";

type BudgetState =
  | { kind: "loading" }
  | { kind: "ready"; summary: BudgetUsageSummary }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const formatUsd = (value: number): string =>
  value === 0 ? "$0.00" : `$${value.toFixed(value >= 1 ? 2 : 4)}`;

export const BudgetOverviewTab = (): JSX.Element => {
  const [days, setDays] = useState(7);
  const [state, setState] = useState<BudgetState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    window.harness.learner
      .summarizeBudgetUsage({ days })
      .then((summary) => {
        if (!cancelled) setState({ kind: "ready", summary });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="budget-overview">
      <div className="budget-overview__toolbar">
        <h3>Budget Overview</h3>
        <select
          className="settings-field__input"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          aria-label="Budget window"
        >
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </div>

      {state.kind === "loading" ? (
        <div className="empty-state">Budget 사용량을 불러오는 중...</div>
      ) : null}
      {state.kind === "error" ? (
        <div className="error-message">{state.message}</div>
      ) : null}
      {state.kind === "ready" ? (
        <BudgetOverviewContent summary={state.summary} />
      ) : null}
    </div>
  );
};

export const BudgetOverviewContent = ({
  summary,
}: {
  summary: BudgetUsageSummary;
}): JSX.Element => {
  const maxCost = useMemo(() => maxDailyProfileCost(summary), [summary]);
  return (
    <div className="budget-overview__content">
      <dl className="budget-overview__metrics">
        <div>
          <dt>Today</dt>
          <dd>{formatUsd(summary.todayCostUsd)}</dd>
        </div>
        <div>
          <dt>{summary.days}-day avg</dt>
          <dd>{formatUsd(summary.averageDailyCostUsd)}</dd>
        </div>
        <div>
          <dt>{summary.days}-day total</dt>
          <dd>{formatUsd(summary.windowCostUsd)}</dd>
        </div>
        <div>
          <dt>Profiles</dt>
          <dd>{summary.profiles.length}</dd>
        </div>
      </dl>

      {isBudgetUsageEmpty(summary) ? (
        <div className="empty-state">표시할 budget 사용량이 없습니다.</div>
      ) : null}

      {summary.profiles.length > 0 ? (
        <section className="budget-overview__charts" aria-label="Profile cost trend">
          {summary.profiles.map((profile) => (
            <ProfileTrend
              key={profile.profileId}
              profile={profile}
              maxCost={maxCost}
            />
          ))}
        </section>
      ) : null}

      {summary.profiles.length > 0 ? (
        <ProfileUsageTable profiles={summary.profiles} />
      ) : null}

      {summary.topModels.length > 0 ? (
        <section className="budget-overview__models" aria-label="Top consumer models">
          <div className="budget-overview__section-head">
            <h4>Top models</h4>
            <span>{summary.topModels.length}</span>
          </div>
          <ol className="budget-overview__model-list">
            {summary.topModels.map((model) => (
              <li key={model.model}>
                <span>{model.model}</span>
                <strong>
                  {formatUsd(model.totalCostUsd)} · {model.invocationCount}
                </strong>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
};

const ProfileTrend = ({
  profile,
  maxCost,
}: {
  profile: BudgetUsageProfileSummary;
  maxCost: number;
}): JSX.Element => {
  const tone = budgetUsageTone(profile);
  return (
    <article className="budget-overview__profile">
      <div className="budget-overview__profile-head">
        <div>
          <h4>{profile.profileName}</h4>
          <span>{profile.model}</span>
        </div>
        <span className={`status-pill status-pill--${toneClass(tone)}`}>
          {formatUsd(profile.todayCostUsd)}
        </span>
      </div>
      <svg
        className="budget-overview__sparkline"
        viewBox="0 0 120 44"
        role="img"
        aria-label={`${profile.profileName} daily budget usage`}
        preserveAspectRatio="none"
      >
        {profile.daily.map((point, index) => {
          const width = 120 / Math.max(1, profile.daily.length);
          const height =
            maxCost > 0 ? Math.max(1, (point.totalCostUsd / maxCost) * 36) : 1;
          return (
            <rect
              key={point.dateIso}
              x={index * width + 1}
              y={42 - height}
              width={Math.max(2, width - 2)}
              height={height}
              rx="1"
              className="budget-overview__bar"
            />
          );
        })}
      </svg>
      {profile.dailyBudgetRatio !== undefined ? (
        <div className="budget-overview__budget-track" role="meter">
          <div
            className={`budget-overview__budget-fill budget-overview__budget-fill--${tone}`}
            style={{ width: `${dailyBudgetPercent(profile)}%` }}
          />
        </div>
      ) : null}
    </article>
  );
};

const ProfileUsageTable = ({
  profiles,
}: {
  profiles: BudgetUsageProfileSummary[];
}): JSX.Element => (
  <section className="budget-overview__table-section" aria-label="Profile usage">
    <div className="budget-overview__section-head">
      <h4>Profiles</h4>
      <span>{profiles.length}</span>
    </div>
    <div className="budget-overview__table-wrap">
      <table className="budget-overview__table">
        <thead>
          <tr>
            <th>Profile</th>
            <th>Limits</th>
            <th>Today</th>
            <th>Window</th>
            <th>Average</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.profileId}>
              <td>
                <strong>{profile.profileName}</strong>
                <span>{profile.model}</span>
              </td>
              <td>{formatBudget(profile.budget)}</td>
              <td>{formatUsd(profile.todayCostUsd)}</td>
              <td>{formatUsd(profile.windowCostUsd)}</td>
              <td>{formatUsd(profile.averageDailyCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

const formatBudget = (budget: AgentBudget | undefined): string => {
  if (!budget) return "none";
  const parts = [
    budget.perInvocationUsd !== undefined
      ? `call ${formatUsd(budget.perInvocationUsd)}`
      : "",
    budget.perTaskRunUsd !== undefined
      ? `run ${formatUsd(budget.perTaskRunUsd)}`
      : "",
    budget.perDayUsd !== undefined ? `day ${formatUsd(budget.perDayUsd)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "none";
};

const toneClass = (tone: ReturnType<typeof budgetUsageTone>): string => {
  if (tone === "failed") return "failed";
  if (tone === "warning") return "warning";
  return "neutral";
};
