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
  maxDailyProfileTokens,
  unknownTokenUsageCount,
} from "./budget-overview-model";

type BudgetState =
  | { kind: "loading" }
  | { kind: "ready"; summary: BudgetUsageSummary }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const formatUsd = (value: number): string =>
  value === 0 ? "$0.00" : `$${value.toFixed(value >= 1 ? 2 : 4)}`;

const numberFormat = new Intl.NumberFormat();

const formatTokens = (value: number): string =>
  numberFormat.format(Math.round(value));

const formatKnownTokens = (
  value: number | undefined,
  unknownCount = 0,
): string => {
  if (value === undefined) return "Unknown";
  return unknownCount > 0
    ? `${formatTokens(value)} tokens known`
    : `${formatTokens(value)} tokens`;
};

const unknownTokenNotice = (count: number): string =>
  count === 1
    ? "1 call has unknown token usage"
    : `${count} calls have unknown token usage`;

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
  const maxTokens = useMemo(() => maxDailyProfileTokens(summary), [summary]);
  const unknownCount = unknownTokenUsageCount(summary);
  const todayUnknownCount = unknownTodayTokenCount(summary);
  return (
    <div className="budget-overview__content">
      <dl className="budget-overview__metrics">
        <div>
          <dt>Today</dt>
          <dd>{formatKnownTokens(summary.todayTokens, todayUnknownCount)}</dd>
        </div>
        <div>
          <dt>{summary.days}-day avg</dt>
          <dd>{formatKnownTokens(summary.averageDailyTokens, unknownCount)}</dd>
        </div>
        <div>
          <dt>{summary.days}-day total</dt>
          <dd>{formatKnownTokens(summary.windowTokens, unknownCount)}</dd>
        </div>
        <div>
          <dt>Profiles</dt>
          <dd>{summary.profiles.length}</dd>
        </div>
      </dl>

      {unknownCount > 0 ? (
        <div className="empty-state">{unknownTokenNotice(unknownCount)}.</div>
      ) : null}

      {isBudgetUsageEmpty(summary) ? (
        <div className="empty-state">표시할 budget 사용량이 없습니다.</div>
      ) : null}

      {summary.profiles.length > 0 ? (
        <section className="budget-overview__charts" aria-label="Profile token trend">
          {summary.profiles.map((profile) => (
            <ProfileTrend
              key={profile.profileId}
              profile={profile}
              maxTokens={maxTokens}
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
                  {formatKnownTokens(
                    model.totalTokens,
                    modelUnknownTokenCount(model),
                  )}{" "}
                  · {model.invocationCount}
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
  maxTokens,
}: {
  profile: BudgetUsageProfileSummary;
  maxTokens: number;
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
          {formatKnownTokens(profile.todayTokens, profileTodayUnknownTokenCount(profile))}
        </span>
      </div>
      <svg
        className="budget-overview__sparkline"
        viewBox="0 0 120 44"
        role="img"
        aria-label={`${profile.profileName} daily token usage`}
        preserveAspectRatio="none"
      >
        {profile.daily.map((point, index) => {
          const width = 120 / Math.max(1, profile.daily.length);
          const height =
            maxTokens > 0
              ? Math.max(1, ((point.totalTokens ?? 0) / maxTokens) * 36)
              : 1;
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
            <th>USD caps</th>
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
              <td>
                {formatKnownTokens(
                  profile.todayTokens,
                  profileTodayUnknownTokenCount(profile),
                )}
              </td>
              <td>
                {formatKnownTokens(
                  profile.windowTokens,
                  profile.unknownTokenInvocationCount ?? 0,
                )}
              </td>
              <td>
                {formatKnownTokens(
                  profile.averageDailyTokens,
                  profile.unknownTokenInvocationCount ?? 0,
                )}
              </td>
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

const profileTodayUnknownTokenCount = (
  profile: BudgetUsageProfileSummary,
): number =>
  profile.daily.at(-1)?.unknownTokenInvocationCount ??
  (profile.daily.at(-1)?.totalTokens === undefined
    ? profile.daily.at(-1)?.count
    : undefined) ??
  profile.unknownTokenInvocationCount ??
  0;

const unknownTodayTokenCount = (summary: BudgetUsageSummary): number =>
  summary.profiles.reduce(
    (sum, profile) => sum + profileTodayUnknownTokenCount(profile),
    0,
  );

const modelUnknownTokenCount = (
  model: BudgetUsageSummary["topModels"][number],
): number =>
  model.unknownTokenInvocationCount ??
  (model.totalTokens === undefined ? model.invocationCount : 0);
