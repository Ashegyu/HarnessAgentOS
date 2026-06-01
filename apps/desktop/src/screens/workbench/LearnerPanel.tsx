import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Approval,
  ContextOutcomeSummary,
  LearnerContextDecisionSurface,
  LearnerRecommendation,
  LearningTrace,
  ObservationRecallResult,
  ObservationReuseRisk,
  TaskRun,
} from "@harness/core";
import { RecommendationCard } from "./RecommendationCard";

interface LearnerPanelProps {
  taskRun: TaskRun | null;
  approvals?: Approval[];
  profileId?: string | null;
  onApprovalCreated?: () => Promise<void>;
  pinnedObservationIds?: string[];
  onPinnedObservationToggle?: (
    context: ObservationRecallResult,
    surface?: LearnerContextDecisionSurface,
  ) => void;
}

type RecommendationState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; recommendation: LearnerRecommendation }
  | { kind: "error"; message: string };

type TraceState =
  | { kind: "idle" }
  | { kind: "ready"; trace: LearningTrace | null }
  | { kind: "error"; message: string };

type ContextRecallState =
  | { kind: "idle" }
  | { kind: "ready"; results: ObservationRecallResult[] }
  | { kind: "error"; message: string };

type ContextSummaryState =
  | { kind: "idle" }
  | { kind: "ready"; summary: ContextOutcomeSummary }
  | { kind: "error"; message: string };

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const recallOutcomeText = (
  outcome: ObservationRecallResult["outcome"] | undefined,
): string | null => {
  if (!outcome || outcome.usedCount === 0) return null;
  const last =
    outcome.lastStatus === "passed"
      ? "최근 성공"
      : outcome.lastStatus === "warning"
        ? "최근 경고"
        : outcome.lastStatus === "failed"
          ? "최근 실패"
          : "최근 결과 없음";
  return `성과 ${outcome.usedCount}회 · 성공 ${outcome.passedCount} · 경고 ${outcome.warningCount} · 실패 ${outcome.failedCount} · ${last}`;
};

const signedScoreAdjustment = (value: number): string =>
  value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);

const reuseRiskText = (risk: ObservationReuseRisk | undefined): string | null => {
  if (risk === "high") return "재사용 주의";
  if (risk === "medium") return "재사용 검토";
  if (risk === "low") return "재사용 우선";
  return null;
};

const outcomeStatusText = (
  status: ContextOutcomeSummary["recentOutcomes"][number]["status"],
): string => {
  if (status === "passed") return "성공";
  if (status === "warning") return "경고";
  return "실패";
};

const outcomeSourceText = (
  source:
    | ContextOutcomeSummary["recentOutcomes"][number]["outcomeSource"]
    | undefined,
): string => {
  if (source === "quality") return "quality";
  if (source === "agent") return "agent";
  if (source === "runner") return "runner";
  return "unknown";
};

export const LearnerPanel = ({
  taskRun,
  approvals = [],
  onApprovalCreated,
  pinnedObservationIds = [],
  onPinnedObservationToggle,
}: LearnerPanelProps): JSX.Element => {
  const [recState, setRecState] = useState<RecommendationState>({
    kind: "idle",
  });
  const [traceState, setTraceState] = useState<TraceState>({ kind: "idle" });
  const [contextState, setContextState] = useState<ContextRecallState>({
    kind: "idle",
  });
  const [contextSummaryState, setContextSummaryState] =
    useState<ContextSummaryState>({
      kind: "idle",
    });
  const [proposalMessage, setProposalMessage] = useState<string | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const pinnedObservationIdSet = useMemo(
    () => new Set(pinnedObservationIds),
    [pinnedObservationIds],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!taskRun) {
      setRecState({ kind: "idle" });
      setTraceState({ kind: "idle" });
      setContextState({ kind: "idle" });
      setContextSummaryState({ kind: "idle" });
      return;
    }
    setRecState({ kind: "loading" });
    try {
      const recommendation = await window.harness.learner.recommend({
        taskRunId: taskRun.id,
      });
      setRecState({ kind: "ready", recommendation });
    } catch (e) {
      setRecState({ kind: "error", message: errorMessage(e) });
    }
    try {
      const trace = await window.harness.learner.getTrace({
        taskRunId: taskRun.id,
      });
      setTraceState({ kind: "ready", trace });
    } catch (e) {
      setTraceState({ kind: "error", message: errorMessage(e) });
    }
    try {
      const results = await window.harness.learner.recallContext({
        taskRunId: taskRun.id,
        limit: 5,
      });
      setContextState({ kind: "ready", results });
    } catch (e) {
      setContextState({ kind: "error", message: errorMessage(e) });
    }
    try {
      const summary = await window.harness.learner.summarizeContextOutcomes({
        taskRunId: taskRun.id,
        limit: 5,
      });
      setContextSummaryState({ kind: "ready", summary });
    } catch (e) {
      setContextSummaryState({ kind: "error", message: errorMessage(e) });
    }
  }, [taskRun]);

  useEffect(() => {
    setProposalMessage(null);
    void refresh();
  }, [refresh]);

  const recordDecision = useCallback(
    async (
      decision: "accepted" | "rejected",
      reason: string,
    ): Promise<string | null> => {
      if (!taskRun || recState.kind !== "ready") return null;
      try {
        await window.harness.learner.recordDecision({
          taskRunId: taskRun.id,
          recommendationId: recState.recommendation.id,
          decision,
          reason,
        });
        return null;
      } catch (e) {
        return `감사 로그 기록 실패: ${errorMessage(e)}`;
      }
    },
    [taskRun, recState],
  );

  const handleProposeRecommendation = useCallback(
    async (): Promise<void> => {
      if (!taskRun || recState.kind !== "ready") return;
      setProposalBusy(true);
      setProposalMessage(null);
      try {
        const result = await window.harness.learner.proposeRecommendation({
          taskRunId: taskRun.id,
        });
        const auditWarning = await recordDecision(
          "accepted",
          "user proposed learner recommendation approvals",
        );
        const message =
          result.approvals.length > 0
            ? `${result.approvals.length}개 Learner 추천 후보가 approval로 올라갔습니다.`
            : "새로 올릴 Learner 추천 후보가 없습니다.";
        setProposalMessage(
          auditWarning ? `${message} ${auditWarning}` : message,
        );
        await onApprovalCreated?.();
        await refresh();
      } catch (e) {
        setProposalMessage(errorMessage(e));
      } finally {
        setProposalBusy(false);
      }
    },
    [taskRun, recState, recordDecision, refresh, onApprovalCreated],
  );

  const handleRejectRecommendation = useCallback(
    async (): Promise<void> => {
      if (!taskRun || recState.kind !== "ready") return;
      setProposalBusy(true);
      setProposalMessage(null);
      try {
        const auditWarning = await recordDecision(
          "rejected",
          "user dismissed learner recommendation",
        );
        setProposalMessage(
          auditWarning ?? "Learner 추천을 거절로 기록했습니다.",
        );
        await refresh();
      } finally {
        setProposalBusy(false);
      }
    },
    [taskRun, recState, recordDecision, refresh],
  );

  if (!taskRun) {
    return (
      <div className="empty-state">
        TaskRun을 선택하면 추천이 계산됩니다.
      </div>
    );
  }

  return (
    <div className="learner-panel">
      {recState.kind === "loading" ? (
        <div className="empty-state">추천 계산 중…</div>
      ) : null}
      {recState.kind === "error" ? (
        <div className="error-message">{recState.message}</div>
      ) : null}
      {recState.kind === "ready" ? (
        <RecommendationCard
          recommendation={recState.recommendation}
          approvals={approvals}
          pinnedObservationIds={pinnedObservationIds}
          onPinnedObservationToggle={onPinnedObservationToggle}
          disabled={proposalBusy}
          onPropose={handleProposeRecommendation}
          onReject={handleRejectRecommendation}
        />
      ) : null}
      {proposalMessage ? (
        <div className="muted">
          {proposalMessage}
        </div>
      ) : null}

      <section className="learner-panel__trace">
        <header className="learner-panel__trace-header">context observability</header>
        {contextSummaryState.kind === "ready" ? (
          <>
            <ul className="learner-panel__metrics">
              <li>
                context pack:{" "}
                <strong>{contextSummaryState.summary.contextPackCount}</strong>
              </li>
              <li>
                선택 context pack:{" "}
                <strong>
                  {contextSummaryState.summary.pinnedContextPackCount}
                </strong>
              </li>
              <li>
                검증 context pack:{" "}
                <strong>
                  {contextSummaryState.summary.verifiedContextPackCount}
                </strong>{" "}
                · 대기 {contextSummaryState.summary.pendingContextPackCount}
              </li>
              <li>
                outcome:{" "}
                <strong>{contextSummaryState.summary.outcomeCount}</strong>
              </li>
              <li>
                선택 의사결정:{" "}
                <strong>
                  {contextSummaryState.summary.contextDecisionCount}
                </strong>{" "}
                · pin {contextSummaryState.summary.contextPinnedDecisionCount} ·
                unpin {contextSummaryState.summary.contextUnpinnedDecisionCount}
              </li>
              <li>
                결과: 성공 {contextSummaryState.summary.passedCount} · 경고{" "}
                {contextSummaryState.summary.warningCount} · 실패{" "}
                {contextSummaryState.summary.failedCount}
              </li>
              <li>
                출처: quality {contextSummaryState.summary.qualityOutcomeCount} ·
                agent {contextSummaryState.summary.agentOutcomeCount} · runner{" "}
                {contextSummaryState.summary.runnerOutcomeCount}
                {contextSummaryState.summary.unknownOutcomeCount > 0
                  ? ` · unknown ${contextSummaryState.summary.unknownOutcomeCount}`
                  : ""}
              </li>
            </ul>
            {contextSummaryState.summary.riskObservations.length > 0 ? (
              <>
                <header className="learner-panel__trace-header">
                  주의 context
                </header>
                <ul className="capability-list">
                  {contextSummaryState.summary.riskObservations.map((item) => (
                    <li key={item.observationId} className="capability-item">
                      <div className="capability-item__header">
                        <span className="capability-item__name">
                          {item.source && item.signal
                            ? `${item.source}:${item.signal}`
                            : item.observationId}
                        </span>
                        <span className="status-pill">
                          {reuseRiskText(item.reuseRisk) ?? "재사용 검토"} · 실패{" "}
                          {item.failedCount}
                        </span>
                      </div>
                      {item.summary ? (
                        <p className="capability-item__desc">{item.summary}</p>
                      ) : null}
                      <p className="capability-item__reason">
                        성공 {item.passedCount} · 경고 {item.warningCount} · 보정{" "}
                        {signedScoreAdjustment(item.scoreAdjustment)}
                        {item.lastStatus ? ` · 최근 ${item.lastStatus}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {contextSummaryState.summary.topObservations.length > 0 ? (
              <ul className="capability-list">
                {contextSummaryState.summary.topObservations.map((item) => (
                  <li key={item.observationId} className="capability-item">
                    <div className="capability-item__header">
                      <span className="capability-item__name">
                        {item.source && item.signal
                          ? `${item.source}:${item.signal}`
                          : item.observationId}
                      </span>
                      <span className="status-pill">
                        사용 {item.usedCount} ·{" "}
                        {signedScoreAdjustment(item.scoreAdjustment)}
                        {reuseRiskText(item.reuseRisk)
                          ? ` · ${reuseRiskText(item.reuseRisk)}`
                          : ""}
                      </span>
                    </div>
                    {item.summary ? (
                      <p className="capability-item__desc">{item.summary}</p>
                    ) : null}
                    <p className="capability-item__reason">
                      성공 {item.passedCount} · 경고 {item.warningCount} · 실패{" "}
                      {item.failedCount}
                      {item.lastStatus ? ` · 최근 ${item.lastStatus}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">아직 context outcome이 없습니다.</div>
            )}
            {contextSummaryState.summary.recentOutcomes.length > 0 ? (
              <>
                <header className="learner-panel__trace-header">최근 outcome</header>
                <ul className="capability-list">
                  {contextSummaryState.summary.recentOutcomes.map((item) => (
                    <li
                      key={item.outcomeObservationId}
                      className="capability-item"
                    >
                      <div className="capability-item__header">
                        <span className="capability-item__name">
                          {outcomeSourceText(item.outcomeSource)}{" "}
                          {outcomeStatusText(item.status)}
                        </span>
                        <span className="status-pill">
                          context {item.pinnedObservationIds.length}
                        </span>
                      </div>
                      <p className="capability-item__desc">{item.summary}</p>
                      <p className="capability-item__reason">
                        {item.createdAt}
                        {item.taskRunId ? ` · ${item.taskRunId}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {contextSummaryState.summary.recentContextDecisions.length > 0 ? (
              <>
                <header className="learner-panel__trace-header">
                  최근 context 선택
                </header>
                <ul className="capability-list">
                  {contextSummaryState.summary.recentContextDecisions.map(
                    (item) => (
                      <li
                        key={item.decisionObservationId}
                        className="capability-item"
                      >
                        <div className="capability-item__header">
                          <span className="capability-item__name">
                            {item.decision} · {item.surface}
                          </span>
                          <span className="status-pill">
                            {item.reuseRisk
                              ? reuseRiskText(item.reuseRisk)
                              : "재사용 정보 없음"}
                          </span>
                        </div>
                        <p className="capability-item__desc">
                          {item.observationId}
                        </p>
                        <p className="capability-item__reason">
                          {item.createdAt}
                          {typeof item.score === "number"
                            ? ` · score ${item.score.toFixed(2)}`
                            : ""}
                        </p>
                      </li>
                    ),
                  )}
                </ul>
              </>
            ) : null}
            {contextSummaryState.summary.recentContextPacks.length > 0 ? (
              <>
                <header className="learner-panel__trace-header">
                  최근 context pack
                </header>
                <ul className="capability-list">
                  {contextSummaryState.summary.recentContextPacks.map((item) => (
                    <li
                      key={item.contextPackObservationId}
                      className="capability-item"
                    >
                      <div className="capability-item__header">
                        <span className="capability-item__name">
                          context {item.pinnedObservationIds.length}
                        </span>
                        <span className="status-pill">
                          {item.outcome
                            ? `outcome ${outcomeSourceText(
                                item.outcome.outcomeSource,
                              )} ${outcomeStatusText(item.outcome.status)}`
                            : "outcome 없음"}
                        </span>
                      </div>
                      {item.outcome ? (
                        <p className="capability-item__desc">
                          {item.outcome.summary}
                        </p>
                      ) : null}
                      <p className="capability-item__reason">
                        {item.createdAt}
                        {item.contextPackArtifactId
                          ? ` · ${item.contextPackArtifactId}`
                          : ""}
                        {item.taskRunId ? ` · ${item.taskRunId}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : contextSummaryState.kind === "error" ? (
          <div className="error-message">{contextSummaryState.message}</div>
        ) : (
          <div className="empty-state">context outcome 집계가 없습니다.</div>
        )}
      </section>

      <section className="learner-panel__trace">
        <header className="learner-panel__trace-header">관련 context</header>
        {contextState.kind === "ready" && contextState.results.length > 0 ? (
          <ul className="capability-list">
            {contextState.results.map((result) => (
              <li key={result.observationId} className="capability-item">
                <div className="capability-item__header">
                  <span className="capability-item__name">
                    {result.source}:{result.signal}
                  </span>
                  <span className="status-pill">
                    score {result.score.toFixed(2)}
                    {reuseRiskText(result.outcome?.reuseRisk)
                      ? ` · ${reuseRiskText(result.outcome?.reuseRisk)}`
                      : ""}
                  </span>
                </div>
                <p className="capability-item__desc">{result.summary}</p>
                <p className="capability-item__reason">
                  {result.eventType} · {result.createdAt}
                </p>
                {recallOutcomeText(result.outcome) ? (
                  <p className="capability-item__reason">
                    {recallOutcomeText(result.outcome)}
                  </p>
                ) : null}
                {onPinnedObservationToggle ? (
                  <button
                    type="button"
                    aria-pressed={pinnedObservationIdSet.has(result.observationId)}
                    onClick={() => onPinnedObservationToggle(result, "recall")}
                  >
                    {pinnedObservationIdSet.has(result.observationId)
                      ? "context 선택 해제"
                      : "context 선택"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : contextState.kind === "error" ? (
          <div className="error-message">{contextState.message}</div>
        ) : (
          <div className="empty-state">관련 observation이 없습니다.</div>
        )}
      </section>

      <section className="learner-panel__trace">
        <header className="learner-panel__trace-header">현재 trace</header>
        {traceState.kind === "ready" && traceState.trace ? (
          <ul className="learner-panel__metrics">
            <li>
              모델:{" "}
              <strong>
                {traceState.trace.selectedModel ?? "기록 없음"}
              </strong>
            </li>
            <li>
              선택된 capability: {traceState.trace.selectedCapabilities.length}
            </li>
            <li>
              reward:{" "}
              <strong>
                {typeof traceState.trace.reward === "number"
                  ? traceState.trace.reward.toFixed(2)
                  : "—"}
              </strong>
            </li>
            <li>
              latency:{" "}
              <strong>
                {typeof traceState.trace.latencyMs === "number"
                  ? `${traceState.trace.latencyMs}ms`
                  : "—"}
              </strong>
            </li>
            <li>
              cost:{" "}
              <strong>
                {typeof traceState.trace.costEstimate === "number"
                  ? traceState.trace.costEstimate.toFixed(2)
                  : "—"}
              </strong>
            </li>
            {traceState.trace.success === false ? (
              <li className="error-message">
                실패 원인: {traceState.trace.failureReason ?? "기록 없음"}
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="empty-state">아직 trace 기록이 없습니다.</div>
        )}
      </section>
    </div>
  );
};
