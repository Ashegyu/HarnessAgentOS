interface DiffViewerProps {
  content: string;
}

export const DiffViewer = ({ content }: DiffViewerProps): JSX.Element => {
  const lines = content.split(/\r?\n/);
  return (
    <pre className="diff-viewer">
      {lines.map((line, idx) => {
        let cls = "diff-viewer__line";
        if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-viewer__line--header";
        else if (line.startsWith("+")) cls += " diff-viewer__line--add";
        else if (line.startsWith("-")) cls += " diff-viewer__line--del";
        return (
          <span key={idx} className={cls}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
};
