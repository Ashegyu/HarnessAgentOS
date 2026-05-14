import type { ParsedStreamSection } from "./agent-stream-parser";

interface AgentStreamSectionsProps {
  sections: readonly ParsedStreamSection[];
  surface: "inline" | "panel";
  terminal: boolean;
  fallbackFinalText?: string | null;
}

export const AgentStreamSections = ({
  sections,
  surface,
  terminal,
  fallbackFinalText = null,
}: AgentStreamSectionsProps): JSX.Element => {
  const displaySections: readonly ParsedStreamSection[] =
    sections.length > 0
      ? sections
      : fallbackFinalText
        ? [{ id: "fallback-final", kind: "final", text: fallbackFinalText }]
        : [];
  return (
    <>
      {displaySections.map((section, index) => (
        <AgentStreamSection
          key={section.id}
          index={index}
          section={section}
          surface={surface}
          terminal={terminal}
        />
      ))}
    </>
  );
};

interface AgentStreamSectionProps {
  index: number;
  section: ParsedStreamSection;
  surface: "inline" | "panel";
  terminal: boolean;
}

const AgentStreamSection = ({
  index,
  section,
  surface,
  terminal,
}: AgentStreamSectionProps): JSX.Element => {
  const classes = sectionClasses(section, surface);
  const title = sectionTitle(section);
  const content = sectionContent(section, surface);
  const collapsible = section.kind !== "final";

  if (!collapsible) {
    return (
      <section className={classes.root}>
        <header className={classes.head}>
          {surface === "inline" && (
            <span className="inline-agent-stream__icon" aria-hidden>
              {sectionIcon(section)}
            </span>
          )}
          <span className={classes.title}>{title}</span>
        </header>
        {content}
      </section>
    );
  }

  return (
    <details className={classes.root} open={!terminal}>
      <summary className={classes.head}>
        {surface === "inline" && (
          <span className="inline-agent-stream__icon" aria-hidden>
            {sectionIcon(section)}
          </span>
        )}
        <span className={classes.title}>{title}</span>
        <span className={classes.ordinal}>{index + 1}</span>
        <span className={classes.chevron} aria-hidden>
          ▸
        </span>
      </summary>
      {content}
    </details>
  );
};

const sectionClasses = (
  section: ParsedStreamSection,
  surface: "inline" | "panel",
): {
  root: string;
  head: string;
  title: string;
  chevron: string;
  ordinal: string;
} => {
  if (surface === "panel") {
    const modifier =
      section.kind === "thinking" ? " agent-stream-section--thinking" : "";
    return {
      root: `agent-stream-section${modifier}`,
      head: "agent-stream-section__head",
      title: "agent-stream-section__title",
      chevron: "agent-stream-section__chevron",
      ordinal: "agent-stream-section__ordinal",
    };
  }
  return {
    root: `inline-agent-stream__section ${inlineSectionModifier(section.kind)}`,
    head: "inline-agent-stream__head",
    title: "inline-agent-stream__title",
    chevron: "inline-agent-stream__chevron",
    ordinal: "inline-agent-stream__ordinal",
  };
};

const inlineSectionModifier = (kind: ParsedStreamSection["kind"]): string => {
  switch (kind) {
    case "thinking":
      return "inline-agent-stream__section--thinking";
    case "tool":
      return "inline-agent-stream__section--tool";
    case "final":
      return "inline-agent-stream__section--final";
    case "response":
      return "inline-agent-stream__section--live";
  }
};

const sectionTitle = (section: ParsedStreamSection): string => {
  switch (section.kind) {
    case "thinking":
      return "생각 과정";
    case "tool":
      return "명령어 / 도구 호출";
    case "final":
      return "최종 답변";
    case "response":
      return section.phase === "live"
        ? "중간 답변 / 응답 작성 중"
        : "중간 답변";
  }
};

const sectionIcon = (section: ParsedStreamSection): string => {
  switch (section.kind) {
    case "thinking":
      return "✦";
    case "tool":
      return "▷";
    case "final":
      return "✓";
    case "response":
      return "…";
  }
};

const sectionContent = (
  section: ParsedStreamSection,
  surface: "inline" | "panel",
): JSX.Element => {
  const prefix = surface === "inline"
    ? "inline-agent-stream"
    : "agent-stream-section";
  switch (section.kind) {
    case "thinking":
      return <div className={`${prefix}__thinking`}>{section.text}</div>;
    case "response":
      return <div className={`${prefix}__live`}>{section.text}</div>;
    case "final":
      return <pre className={`${prefix}__final`}>{section.text}</pre>;
    case "tool":
      return (
        <ul className={`${prefix}__tools`}>
          <li>
            <code>{section.name}</code>
            {section.input ? (
              <span className={`${prefix}__tool-input`}>
                {formatToolInput(section.input)}
              </span>
            ) : null}
          </li>
        </ul>
      );
  }
};

const formatToolInput = (input: unknown): string => {
  if (typeof input === "string") return input.slice(0, 240);
  if (input && typeof input === "object") {
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
    const timeout =
      numberValue(record["timeout_ms"]) ?? numberValue(record["timeoutMs"]);
    const reason =
      stringValue(record["rationale"]) ?? stringValue(record["reason"]);
    const parts = [
      primary,
      cwd ? `cwd: ${cwd}` : null,
      timeout !== null ? `timeout: ${timeout}ms` : null,
      reason,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(" · ").slice(0, 240);
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
