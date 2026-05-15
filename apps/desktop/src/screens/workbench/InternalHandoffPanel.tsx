import {
  handoffEntryDisplayText,
  type AgentHandoffDelivery,
} from "./agent-handoff-display";

interface InternalHandoffPanelProps {
  handoffs: AgentHandoffDelivery[];
}

export const InternalHandoffPanel = ({
  handoffs,
}: InternalHandoffPanelProps): JSX.Element | null => {
  if (handoffs.length === 0) return null;
  const entryCount = handoffs.reduce(
    (total, delivery) => total + delivery.entries.length,
    0,
  );

  return (
    <details className="agent-handoff" open>
      <summary className="agent-handoff__summary">
        <span className="agent-handoff__title">Internal handoff</span>
        <span className="agent-handoff__count">
          {entryCount}개 메시지 · {handoffs.length}개 프롬프트
        </span>
      </summary>
      <div className="agent-handoff__deliveries">
        {handoffs.map((delivery) => (
          <details
            key={delivery.promptArtifactId}
            className="agent-handoff__delivery"
          >
            <summary className="agent-handoff__route">
              <span className="agent-handoff__route-main">
                {delivery.entries
                  .map((entry) => `${entry.fromRole}: ${entry.fromTitle}`)
                  .join(", ")}
                <span aria-hidden> → </span>
                {delivery.targetLabel}
              </span>
              <code title={delivery.promptArtifactId}>
                {delivery.promptArtifactId.slice(0, 12)}…
              </code>
            </summary>
            <div className="agent-handoff__entries">
              {delivery.entries.map((entry, index) => (
                <article
                  key={`${delivery.promptArtifactId}-${entry.artifactId}-${index}`}
                  className="agent-handoff__entry"
                >
                  <header className="agent-handoff__entry-head">
                    <strong>
                      {entry.fromRole}: {entry.fromTitle}
                    </strong>
                    <code title={entry.artifactId}>{entry.artifactId}</code>
                  </header>
                  {entry.createdAt && (
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  )}
                  <p>{handoffEntryDisplayText(entry)}</p>
                </article>
              ))}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
};
