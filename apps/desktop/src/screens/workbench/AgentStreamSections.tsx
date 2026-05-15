import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ParsedStreamSection } from "./agent-stream-parser";
import { parseAnsiSgr, type AnsiStyle } from "./ansi-sgr";
import { MarkdownText } from "./MarkdownText";
import {
  groupConsecutiveToolSections,
  type AgentStreamDisplaySection,
  type GroupedToolStreamSection,
} from "./agent-stream-section-groups";

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
  const baseSections: readonly ParsedStreamSection[] =
    sections.length > 0
      ? sections
      : fallbackFinalText
        ? [{ id: "fallback-final", kind: "final", text: fallbackFinalText }]
        : [];
  const displaySections = groupConsecutiveToolSections(baseSections);
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
  section: AgentStreamDisplaySection;
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
  section: AgentStreamDisplaySection,
  surface: "inline" | "panel",
): {
  root: string;
  head: string;
  title: string;
  chevron: string;
  ordinal: string;
} => {
  if (surface === "panel") {
    const modifier = section.kind === "thinking"
      ? " agent-stream-section--thinking"
      : "";
    return {
      root: `agent-stream-section${modifier}`,
      head: "agent-stream-section__head",
      title: "agent-stream-section__title",
      chevron: "agent-stream-section__chevron",
      ordinal: "agent-stream-section__ordinal",
    };
  }
  return {
    root: `inline-agent-stream__section ${inlineSectionModifier(section)}`,
    head: "inline-agent-stream__head",
    title: "inline-agent-stream__title",
    chevron: "inline-agent-stream__chevron",
    ordinal: "inline-agent-stream__ordinal",
  };
};

const inlineSectionModifier = (section: AgentStreamDisplaySection): string => {
  switch (section.kind) {
    case "thinking":
      return "inline-agent-stream__section--thinking";
    case "tool":
    case "tool_group":
      return "inline-agent-stream__section--tool";
    case "final":
      return "inline-agent-stream__section--final";
    case "response":
      return "inline-agent-stream__section--live";
  }
};

const sectionTitle = (section: AgentStreamDisplaySection): string => {
  switch (section.kind) {
    case "thinking":
      return "생각 과정";
    case "tool":
      return "명령어 / 도구 호출";
    case "tool_group":
      return `명령어 / 도구 호출 · ${section.tools.length}회`;
    case "final":
      return "최종 답변";
    case "response":
      return section.phase === "live"
        ? "중간 답변 / 응답 작성 중"
        : "중간 답변";
  }
};

const sectionIcon = (section: AgentStreamDisplaySection): string => {
  switch (section.kind) {
    case "thinking":
      return "✦";
    case "tool":
    case "tool_group":
      return "▷";
    case "final":
      return "✓";
    case "response":
      return "…";
  }
};

const sectionContent = (
  section: AgentStreamDisplaySection,
  surface: "inline" | "panel",
): JSX.Element => {
  const prefix = surface === "inline"
    ? "inline-agent-stream"
    : "agent-stream-section";
  switch (section.kind) {
    case "thinking":
      return <div className={`${prefix}__thinking`}>{section.text}</div>;
    case "response":
      return <MarkdownText className={`${prefix}__live`} text={section.text} />;
    case "final":
      return <MarkdownText className={`${prefix}__final`} text={section.text} />;
    case "tool_group":
      return <ToolGroupContent section={section} prefix={prefix} />;
    case "tool":
      return (
        <ul className={`${prefix}__tools`}>
          <ToolRunDetail tool={section} prefix={prefix} />
        </ul>
      );
  }
};

const ToolGroupContent = ({
  section,
  prefix,
}: {
  section: GroupedToolStreamSection;
  prefix: "inline-agent-stream" | "agent-stream-section";
}): JSX.Element => (
  <ul className={`${prefix}__tools ${prefix}__tools--grouped`}>
    <li className={`${prefix}__tool-group-summary`}>
      <code className={`${prefix}__tool-label`}>{displayToolName(section.name)}</code>
      {section.input ? (
        <span className={`${prefix}__tool-input`}>
          {formatToolInput(section.input)}
        </span>
      ) : null}
      <span className={`${prefix}__tool-count`}>{section.tools.length}회</span>
    </li>
    {section.tools.map((tool, index) => (
      <ToolRunDetail key={tool.id} tool={tool} index={index} prefix={prefix} />
    ))}
  </ul>
);

const ToolRunDetail = ({
  tool,
  index,
  prefix,
}: {
  tool: Extract<ParsedStreamSection, { kind: "tool" }>;
  index?: number;
  prefix: "inline-agent-stream" | "agent-stream-section";
}): JSX.Element => {
  const detail = toolRunDisplay(tool);
  return (
    <li className={`${prefix}__tool-run`}>
      <details className={`${prefix}__tool-run-details`} open>
        <summary className={`${prefix}__tool-run-head`}>
          {index !== undefined ? (
            <span className={`${prefix}__tool-index`}>#{index + 1}</span>
          ) : null}
          <code className={`${prefix}__tool-label`}>{detail.label}</code>
          {detail.status ? (
            <span
              className={`${prefix}__tool-status ${prefix}__tool-status--${statusClass(detail.status)}`}
            >
              {detail.status}
            </span>
          ) : null}
          {detail.exitCode !== null ? (
            <span className={`${prefix}__tool-exit`}>exit {detail.exitCode}</span>
          ) : null}
          <span className={`${prefix}__tool-run-chevron`} aria-hidden>
            ▸
          </span>
        </summary>
        <div className={`${prefix}__tool-run-body`}>
          {detail.command ? (
            <pre
              className={`${prefix}__tool-command`}
              title={formatCommandForDisplay(detail)}
            >
              <AutoMarqueeAnsiText text={formatCommandForDisplay(detail)} />
            </pre>
          ) : null}
          {detail.meta.length > 0 ? (
            <div className={`${prefix}__tool-meta`}>{detail.meta.join(" · ")}</div>
          ) : null}
          {detail.output ? (
            <pre className={`${prefix}__tool-output`}><AnsiText text={truncateToolOutput(detail.output)} /></pre>
          ) : null}
          {!detail.command && detail.output === null ? (
            <span className={`${prefix}__tool-input`}>
              <AnsiText text={formatToolRunDetail(tool.input)} />
            </span>
          ) : null}
        </div>
      </details>
    </li>
  );
};

const AnsiText = ({ text }: { text: string }): JSX.Element => (
  <>
    {parseAnsiSgr(text).map((segment, index) => (
      <span key={index} style={ansiReactStyle(segment.style)}>{segment.text}</span>
    ))}
  </>
);

const AutoMarqueeAnsiText = ({ text }: { text: string }): JSX.Element => {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [marquee, setMarquee] = useState<{ shift: number; duration: number }>({
    shift: 0,
    duration: 0,
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = (): void => {
      const overflow = Math.ceil(content.scrollWidth - viewport.clientWidth);
      setMarquee(
        overflow > 2
          ? {
              shift: -overflow,
              duration: Math.max(4, Math.min(18, overflow / 48)),
            }
          : { shift: 0, duration: 0 },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [text]);

  const style = {
    "--tool-marquee-shift": `${marquee.shift}px`,
    "--tool-marquee-duration": `${marquee.duration}s`,
  } as CSSProperties;

  return (
    <span
      ref={viewportRef}
      className={`tool-command-marquee${
        marquee.shift < 0 ? " tool-command-marquee--overflow" : ""
      }`}
    >
      <span ref={contentRef} className="tool-command-marquee__inner" style={style}>
        <AnsiText text={text} />
      </span>
    </span>
  );
};

const ansiReactStyle = (style: AnsiStyle): CSSProperties | undefined => {
  const css: CSSProperties = {};
  let color = style.fg;
  let backgroundColor = style.bg;
  if (style.inverse) {
    color = style.bg ?? "var(--bg-panel)";
    backgroundColor = style.fg ?? "var(--text-primary)";
  }
  if (color) css.color = color;
  if (backgroundColor) {
    css.backgroundColor = backgroundColor;
    css.borderRadius = 2;
    css.padding = "0 1px";
  }
  if (style.bold) css.fontWeight = 700;
  if (style.dim) css.opacity = 0.72;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  return Object.keys(css).length > 0 ? css : undefined;
};

interface ToolRunDisplay {
  label: string;
  command: string | null;
  status: string | null;
  exitCode: number | null;
  output: string | null;
  meta: string[];
}

const toolRunDisplay = (
  tool: Extract<ParsedStreamSection, { kind: "tool" }>,
): ToolRunDisplay => {
  const label = displayToolName(tool.name);
  if (typeof tool.input === "string") {
    return {
      label,
      command: tool.input,
      status: null,
      exitCode: null,
      output: null,
      meta: [],
    };
  }
  if (!tool.input || typeof tool.input !== "object") {
    return {
      label,
      command: null,
      status: null,
      exitCode: null,
      output: null,
      meta: [],
    };
  }
  const record = tool.input as Record<string, unknown>;
  const command =
    stringValue(record["command"]) ??
    stringValue(record["cmd"]) ??
    stringValue(record["path"]) ??
    stringValue(record["filePath"]);
  const status = stringValue(record["status"]);
  const exitCode = numberValue(record["exitCode"]) ?? numberValue(record["exit_code"]);
  const output =
    stringValue(record["outputPreview"]) ??
    stringValue(record["aggregated_output"]);
  const cwd =
    stringValue(record["cwd"]) ??
    stringValue(record["workdir"]) ??
    stringValue(record["workingDirectory"]) ??
    stringValue(record["targetDir"]);
  const timeout =
    numberValue(record["timeout_ms"]) ?? numberValue(record["timeoutMs"]);
  const reason =
    stringValue(record["rationale"]) ?? stringValue(record["reason"]);
  const meta = [
    cwd ? `cwd: ${cwd}` : null,
    timeout !== null ? `timeout: ${timeout}ms` : null,
    reason,
  ].filter((part): part is string => Boolean(part));
  return { label, command, status, exitCode, output, meta };
};

const displayToolName = (name: string): string => {
  if (
    name === "command_execution" ||
    name === "local_shell_call" ||
    name === "shell_command" ||
    name === "shell"
  ) {
    return "Shell";
  }
  if (name === "file_write") return "File";
  if (name === "quality_check") return "Check";
  return name;
};

const statusClass = (status: string): string => {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "succeeded") return "success";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "in_progress" || normalized === "running") return "running";
  return "neutral";
};

const formatCommandForDisplay = (detail: ToolRunDisplay): string =>
  detail.label === "Shell" && detail.command !== null
    ? `$${detail.command}`
    : detail.command ?? "";

const truncateToolOutput = (output: string): string =>
  output.length > 4_000 ? `${output.slice(0, 4_000)}\n…` : output;

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
    const status = stringValue(record["status"]);
    const exitCode = numberValue(record["exitCode"]) ?? numberValue(record["exit_code"]);
    const parts = [
      primary,
      cwd ? `cwd: ${cwd}` : null,
      timeout !== null ? `timeout: ${timeout}ms` : null,
      status ? `status: ${status}` : null,
      exitCode !== null ? `exit: ${exitCode}` : null,
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

const formatToolRunDetail = (input: unknown): string => {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const command =
      stringValue(record["command"]) ??
      stringValue(record["cmd"]) ??
      stringValue(record["path"]) ??
      stringValue(record["filePath"]);
    const status = stringValue(record["status"]);
    const exitCode = numberValue(record["exitCode"]) ?? numberValue(record["exit_code"]);
    const output =
      stringValue(record["outputPreview"]) ??
      stringValue(record["aggregated_output"]);
    const parts = [
      command ? oneLine(command) : null,
      status ? `status: ${status}` : null,
      exitCode !== null ? `exit: ${exitCode}` : null,
      output ? `output: ${oneLine(output)}` : null,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(" · ").slice(0, 220);
  }
  return formatToolInput(input);
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
