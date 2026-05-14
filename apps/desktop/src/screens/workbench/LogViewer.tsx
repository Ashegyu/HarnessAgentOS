import { parseLogContent } from "./log-viewer-model";

interface LogViewerProps {
  content: string;
}

/**
 * Phase 3 log viewer. RunnerService writes the shell log as a markdown
 * doc with `## stdout` / `## stderr` sections; we split & render them
 * separately so the user can spot stderr at a glance.
 */
export const LogViewer = ({ content }: LogViewerProps): JSX.Element => {
  const parsed = parseLogContent(content);

  if (parsed.kind === "plain") {
    return (
      <div className="log-viewer">
        <section>
          <header className="log-viewer__title">log</header>
          <pre className="log-viewer__body">{parsed.content || "(empty)"}</pre>
        </section>
      </div>
    );
  }

  return (
    <div className="log-viewer">
      {parsed.exitCode !== undefined && (
        <div className={`log-viewer__exit log-viewer__exit--${parsed.exitCode === "0" ? "ok" : "err"}`}>
          exit code: {parsed.exitCode}
        </div>
      )}
      <section>
        <header className="log-viewer__title">stdout</header>
        <pre className="log-viewer__body">{parsed.stdout || "(empty)"}</pre>
      </section>
      <section>
        <header className="log-viewer__title log-viewer__title--err">stderr</header>
        <pre className="log-viewer__body log-viewer__body--err">
          {parsed.stderr || "(empty)"}
        </pre>
      </section>
    </div>
  );
};
