import type { Approval, LearnerRecommendation } from "@harness/core";

interface RecommendationCardProps {
  recommendation: LearnerRecommendation;
  approvals: Approval[];
  onPropose: () => Promise<void>;
  disabled?: boolean;
}

const statusLabel = (status: Approval["status"] | null): string => {
  switch (status) {
    case "pending":
      return "승인 대기";
    case "approved":
    case "always_approved_for_run":
      return "승인됨";
    case "executed":
      return "반영 완료";
    case "rejected":
      return "거절됨";
    default:
      return "후보";
  }
};

const statusClass = (status: Approval["status"] | null): string => {
  switch (status) {
    case "pending":
      return "status-badge--warning";
    case "approved":
    case "always_approved_for_run":
    case "executed":
      return "status-badge--success";
    case "rejected":
      return "status-badge--error";
    default:
      return "status-badge--neutral";
  }
};

const modelApprovalStatus = (
  approvals: Approval[],
  model: string | undefined,
): Approval["status"] | null => {
  if (!model) return null;
  return (
    approvals.find(
      (a) =>
        a.actionType === "model_use" &&
        a.proposedAction?.modelUse?.model === model,
    )?.status ?? null
  );
};

const capabilityApprovalStatus = (
  approvals: Approval[],
  capabilityId: string,
): Approval["status"] | null =>
  approvals.find(
    (a) =>
      a.actionType === "capability_use" &&
      a.proposedAction?.capabilityUse?.capabilityId === capabilityId,
  )?.status ?? null;

export const RecommendationCard = ({
  recommendation,
  approvals,
  onPropose,
  disabled,
}: RecommendationCardProps): JSX.Element => {
  const modelStatus = modelApprovalStatus(
    approvals,
    recommendation.recommendedModel,
  );
  const totalCandidates =
    (recommendation.recommendedModel ? 1 : 0) +
    recommendation.recommendedCapabilities.length;
  const proposedCandidates =
    (modelStatus ? 1 : 0) +
    recommendation.recommendedCapabilities.filter(
      (s) => capabilityApprovalStatus(approvals, s.capability.id) !== null,
    ).length;
  const nothingToPropose = totalCandidates === 0;
  const allProposed =
    totalCandidates > 0 && proposedCandidates >= totalCandidates;

  return (
    <article className="recommendation-card">
      <header className="recommendation-card__header">
        <span className="recommendation-card__title">Learner 판단</span>
        <span className="muted">
          신뢰도 {(recommendation.confidence * 100).toFixed(0)}%
        </span>
      </header>
      <p className="recommendation-card__rationale">
        과거 실행 trace, reward, 비용/지연 기록을 기준으로 이번 Agent 호출에
        반영할 후보를 계산했습니다. 승인 전에는 모델이나 Skill 컨텍스트에
        적용되지 않습니다.
      </p>
      {recommendation.recommendedModel ? (
        <p className="recommendation-card__row">
          추천 모델: <strong>{recommendation.recommendedModel}</strong>{" "}
          {typeof recommendation.estimatedCostUsd === "number" ? (
            <span className="muted">
              예상 비용 ${recommendation.estimatedCostUsd.toFixed(2)}
            </span>
          ) : null}{" "}
          <span className={`status-badge ${statusClass(modelStatus)}`}>
            {statusLabel(modelStatus)}
          </span>
        </p>
      ) : (
        <p className="muted">추천 모델 없음</p>
      )}
      {recommendation.recommendedCapabilities.length > 0 ? (
        <ul className="recommendation-card__capabilities">
          {recommendation.recommendedCapabilities.slice(0, 5).map((s) => {
            const status = capabilityApprovalStatus(
              approvals,
              s.capability.id,
            );
            return (
              <li key={s.capability.id}>
                <span>{s.capability.name}</span>
                <span className="muted">
                  {s.capability.riskLevel} · score {s.score.toFixed(2)}
                </span>
                <span className={`status-badge ${statusClass(status)}`}>
                  {statusLabel(status)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">관련 capability가 없습니다.</p>
      )}
      <p className="recommendation-card__rationale">
        판단 근거: {recommendation.rationale}
      </p>
      <p className="recommendation-card__hints muted">
        {recommendation.costHint
          ? `비용 힌트: ${recommendation.costHint}`
          : "비용 정보 없음"}{" "}
        ·{" "}
        {recommendation.latencyHint
          ? `지연 힌트: ${recommendation.latencyHint}`
          : "지연 정보 없음"}
      </p>
      <p className="recommendation-card__hints muted">
        후보를 생성하면 Approval 패널에서 승인/거절합니다. 승인된 모델은 다음
        Agent 호출 모델로, 승인된 capability는 프롬프트 컨텍스트로만
        반영됩니다.
      </p>
      <div className="recommendation-card__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void onPropose()}
          disabled={disabled || nothingToPropose || allProposed}
        >
          {disabled
            ? "후보 생성 중…"
            : allProposed
              ? "후보 생성됨"
              : "후보 approval 생성"}
        </button>
      </div>
    </article>
  );
};
