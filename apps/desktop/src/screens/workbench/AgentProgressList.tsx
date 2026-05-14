import type { AgentProgressEvent } from "@harness/core";

export type AgentProgressItem = Pick<
  AgentProgressEvent,
  "stage" | "message" | "detail" | "at"
>;

export interface AgentProgressToolItem {
  name: string;
  input: unknown;
}

interface AgentProgressListProps {
  items: readonly AgentProgressItem[];
  compact?: boolean;
  tools?: readonly AgentProgressToolItem[];
  terminal?: boolean;
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
  tools = [],
  terminal = false,
}: AgentProgressListProps): JSX.Element | null => {
  if (items.length === 0 && tools.length === 0) return null;
  const visible = compact ? items.slice(-4) : items.slice(-8);
  const latest = items[items.length - 1] ?? null;
  const latestTool = tools[tools.length - 1] ?? null;
  const headerTitle = latest
    ? latest.message
    : latestTool
      ? `${latestTool.name} 실행`
      : "진행 중";
  const headerStage = latest ? STAGE_LABELS[latest.stage] : "Tool";
  const body = (
    <>
      {latest?.detail && (
        <div className="agent-progress__detail">{latest.detail}</div>
      )}
      <ol className="agent-progress__steps agent-progress__steps--timeline">
        {buildTimelineEntries(visible, tools).map((entry) =>
          entry.type === "progress" ? (
            <li key={entry.key}>
              <span className="agent-progress__step-stage">
                {STAGE_LABELS[entry.item.stage]}
              </span>
              <span className="agent-progress__step-message">
                <span>{entry.item.message}</span>
                {entry.item.detail ? (
                  <span className="agent-progress__step-detail">
                    {entry.item.detail}
                  </span>
                ) : null}
              </span>
              <span className="agent-progress__time">
                {formatProgressTime(entry.item.at)}
              </span>
            </li>
          ) : (
            <li
              key={entry.key}
              className="agent-progress__step--tool"
            >
              <span className="agent-progress__step-stage">
                도구 {entry.index + 1}
              </span>
              <span className="agent-progress__step-message agent-progress__step-message--tool">
                <code>{entry.tool.name}</code>
                {formatToolInput(entry.tool.input) ? (
                  <span className="agent-progress__tool-input">
                    {formatToolInput(entry.tool.input)}
                  </span>
                ) : null}
              </span>
              <span className="agent-progress__time">실행</span>
            </li>
          ),
        )}
      </ol>
    </>
  );

  if (terminal) {
    return (
      <details
        className="agent-progress agent-progress--collapsible"
        aria-label="Agent progress"
      >
        <summary className="agent-progress__head">
          <span className="agent-progress__dot" aria-hidden />
          <span className="agent-progress__label">진행 사항</span>
          <span className="agent-progress__title">{headerTitle}</span>
          <span className="agent-progress__stage">{headerStage}</span>
          <span className="agent-progress__chevron" aria-hidden>
            ▸
          </span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className="agent-progress" aria-label="Agent progress">
      <header className="agent-progress__head">
        <span className="agent-progress__dot" aria-hidden />
        <span className="agent-progress__label">진행 사항</span>
        <span className="agent-progress__title">{headerTitle}</span>
        <span className="agent-progress__stage">{headerStage}</span>
      </header>
      {body}
    </section>
  );
};

type TimelineEntry =
  | {
      type: "progress";
      key: string;
      item: AgentProgressItem;
    }
  | {
      type: "tool";
      key: string;
      tool: AgentProgressToolItem;
      index: number;
    };

const buildTimelineEntries = (
  progress: readonly AgentProgressItem[],
  tools: readonly AgentProgressToolItem[],
): TimelineEntry[] => {
  const progressEntries = progress.map((item, index): TimelineEntry => ({
    type: "progress",
    key: `progress-${item.stage}-${item.at}-${index}`,
    item,
  }));
  const toolEntries = tools.map((tool, index): TimelineEntry => ({
    type: "tool",
    key: `tool-${tool.name}-${index}`,
    tool,
    index,
  }));
  if (toolEntries.length === 0) return progressEntries;
  if (progressEntries.length === 0) return toolEntries;

  const cliIndex = progress.findIndex((item) => item.stage === "cli");
  const insertAt = cliIndex >= 0 ? cliIndex + 1 : progressEntries.length;
  return [
    ...progressEntries.slice(0, insertAt),
    ...toolEntries,
    ...progressEntries.slice(insertAt),
  ];
};

const formatToolInput = (input: unknown): string => {
  if (input === null || input === undefined) return "";
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const primary =
      stringValue(record["command"]) ??
      stringValue(record["path"]) ??
      stringValue(record["filePath"]);
    const cwd =
      stringValue(record["cwd"]) ??
      stringValue(record["workdir"]) ??
      stringValue(record["workingDirectory"]) ??
      stringValue(record["targetDir"]);
    const reason =
      stringValue(record["rationale"]) ?? stringValue(record["reason"]);
    const status = stringValue(record["status"]);
    const exitCode = numberValue(record["exitCode"]) ?? numberValue(record["exit_code"]);
    const parts = [
      primary,
      cwd ? `cwd: ${cwd}` : null,
      status ? `status: ${status}` : null,
      exitCode !== null ? `exit: ${exitCode}` : null,
      reason,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(" · ").slice(0, 180);
  }
  try {
    return JSON.stringify(input).slice(0, 180);
  } catch {
    return String(input).slice(0, 180);
  }
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
