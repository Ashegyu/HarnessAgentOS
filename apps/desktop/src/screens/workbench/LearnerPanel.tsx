import { useCallback, useEffect, useState } from "react";
import type {
  Approval,
  LearnerRecommendation,
  LearningTrace,
  TaskRun,
} from "@harness/core";
import { RecommendationCard } from "./RecommendationCard";

interface LearnerPanelProps {
  taskRun: TaskRun | null;
  approvals?: Approval[];
  profileId?: string | null;
  onApprovalCreated?: () => Promise<void>;
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

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const LearnerPanel = ({
  taskRun,
  approvals = [],
  onApprovalCreated,
}: LearnerPanelProps): JSX.Element => {
  const [recState, setRecState] = useState<RecommendationState>({
    kind: "idle",
  });
  const [traceState, setTraceState] = useState<TraceState>({ kind: "idle" });
  const [proposalMessage, setProposalMessage] = useState<string | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!taskRun) {
      setRecState({ kind: "idle" });
      setTraceState({ kind: "idle" });
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
