interface LogViewerProps {
  content: string;
}

/**
 * Phase 3 log viewer. RunnerService writes the shell log as a markdown
 * doc with `## stdout` / `## stderr` sections; we split & render them
 * separately so the user can spot stderr at a glance.
 */
export const LogViewer = ({ content }: LogViewerProps): JSX.Element => {
  const stdoutMatch = content.match(/## stdout\s*\n+([\s\S]*?)(?:\n##|$)/);
  const stderrMatch = content.match(/## stderr\s*\n+([\s\S]*?)$/);
  const exitMatch = content.match(/exit=(-?\d+)/);
  const stdout = (stdoutMatch?.[1] ?? "").trim();
  const stderr = (stderrMatch?.[1] ?? "").trim();
  const exit = exitMatch?.[1];

  return (
    <div className="log-viewer">
      {exit !== undefined && (
        <div className={`log-viewer__exit log-viewer__exit--${exit === "0" ? "ok" : "err"}`}>
          exit code: {exit}
        </div>
      )}
      <section>
        <header className="log-viewer__title">stdout</header>
        <pre className="log-viewer__body">{stdout || "(empty)"}</pre>
      </section>
      <section>
        <header className="log-viewer__title log-viewer__title--err">stderr</header>
        <pre className="log-viewer__body log-viewer__body--err">
          {stderr || "(empty)"}
        </pre>
      </section>
    </div>
  );
};
