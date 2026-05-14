import type { Artifact } from "@harness/core";
import { stripEmbeddedOrchestrationPlanJson } from "./orchestration-plan-display";

interface PlanArtifactViewProps {
  artifacts: Artifact[];
}

export const PlanArtifactView = ({
  artifacts,
}: PlanArtifactViewProps): JSX.Element => {
  const planArtifacts = artifacts
    .filter((a) => a.kind === "plan")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const latest = planArtifacts[planArtifacts.length - 1];
  if (!latest) {
    return (
      <section className="plan-view" aria-label="Plan artifact">
        <div className="empty-state">계획 아티팩트 없음</div>
      </section>
    );
  }

  return (
    <section className="plan-view" aria-label="Plan artifact">
      <header className="plan-view__header">
        <span className="plan-view__title">{latest.title}</span>
        <span className="plan-view__meta" title={latest.uri}>
          {new Date(latest.createdAt).toLocaleString()}
        </span>
      </header>
      <pre className="plan-view__body">
        {stripEmbeddedOrchestrationPlanJson(latest.summary ?? "(빈 계획)")}
      </pre>
      {planArtifacts.length > 1 && (
        <details className="plan-view__history">
          <summary>이전 계획 {planArtifacts.length - 1}개</summary>
          <ul>
            {planArtifacts.slice(0, -1).reverse().map((a) => (
              <li key={a.id}>
                <strong>{a.title}</strong>
                <pre>{stripEmbeddedOrchestrationPlanJson(a.summary ?? "")}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
};
