import { useState } from "react";
import type { LearnerRecommendation } from "@harness/core";

interface RecommendationCardProps {
  recommendation: LearnerRecommendation;
  onAccept: (reason?: string) => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
  disabled?: boolean;
}

export const RecommendationCard = ({
  recommendation,
  onAccept,
  onReject,
  disabled,
}: RecommendationCardProps): JSX.Element => {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (
    decision: "accepted" | "rejected",
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = reason.trim();
      if (decision === "accepted") {
        await onAccept(r || undefined);
      } else {
        await onReject(r || undefined);
      }
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="recommendation-card">
      <header className="recommendation-card__header">
        <span className="recommendation-card__title">추천됨</span>
        <span className="muted">
          신뢰도 {(recommendation.confidence * 100).toFixed(0)}%
        </span>
      </header>
      {recommendation.recommendedModel ? (
        <p className="recommendation-card__row">
          모델: <strong>{recommendation.recommendedModel}</strong>
        </p>
      ) : null}
      {recommendation.recommendedCapabilities.length > 0 ? (
        <ul className="recommendation-card__capabilities">
          {recommendation.recommendedCapabilities.slice(0, 5).map((s) => (
            <li key={s.capability.id}>
              <span>{s.capability.name}</span>
              <span className="muted">
                · {s.capability.riskLevel} · score {s.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">관련 capability가 없습니다.</p>
      )}
      <p className="recommendation-card__rationale">
        {recommendation.rationale}
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
      <label className="form-field">
        <span>의견 (선택)</span>
        <input
          className="textarea"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="예: 이 작업에는 모델이 너무 비쌈"
          disabled={busy || disabled}
        />
      </label>
      {error ? <div className="error-message">{error}</div> : null}
      <div className="recommendation-card__actions">
        <button
          type="button"
          className="btn"
          onClick={() => void handle("rejected")}
          disabled={busy || disabled}
        >
          거절
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handle("accepted")}
          disabled={busy || disabled}
        >
          이 추천 사용
        </button>
      </div>
    </article>
  );
};
