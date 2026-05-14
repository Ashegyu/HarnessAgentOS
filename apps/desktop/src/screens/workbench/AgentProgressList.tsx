import type { AgentProgressEvent } from "@harness/core";

export type AgentProgressItem = Pick<
  AgentProgressEvent,
  "stage" | "message" | "detail" | "at"
>;

interface AgentProgressListProps {
  items: readonly AgentProgressItem[];
  compact?: boolean;
}

const STAGE_LABELS: Record<AgentProgressItem["stage"], string> = {
  context: "Context",
  profile: "Profile",
  prompt: "Prompt",
  session: "Session",
  mcp: "MCP",
  queued: "Queue",
  cli: "CLI",
  parse: "Parse",
  approval: "Approval",
  complete: "Done",
};

const formatProgressTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

export const AgentProgressList = ({
  items,
  compact = false,
}: AgentProgressListProps): JSX.Element | null => {
  if (items.length === 0) return null;
  const visible = compact ? items.slice(-4) : items.slice(-8);
  const latest = items[items.length - 1]!;

  return (
    <section className="agent-progress" aria-label="Agent progress">
      <header className="agent-progress__head">
        <span className="agent-progress__dot" aria-hidden />
        <span className="agent-progress__title">{latest.message}</span>
        <span className="agent-progress__stage">
          {STAGE_LABELS[latest.stage]}
        </span>
      </header>
      {latest.detail && (
        <div className="agent-progress__detail">{latest.detail}</div>
      )}
      <ol className="agent-progress__steps">
        {visible.map((item, index) => (
          <li key={`${item.stage}-${item.at}-${index}`}>
            <span className="agent-progress__step-stage">
              {STAGE_LABELS[item.stage]}
            </span>
            <span className="agent-progress__step-message">
              {item.message}
            </span>
            <span className="agent-progress__time">
              {formatProgressTime(item.at)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
};
