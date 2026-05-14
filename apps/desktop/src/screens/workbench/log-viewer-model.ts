export type ParsedLogContent =
  | {
      kind: "shell";
      exitCode?: string;
      stdout: string;
      stderr: string;
    }
  | {
      kind: "plain";
      content: string;
    };

export const parseLogContent = (content: string): ParsedLogContent => {
  const stdoutMatch = content.match(/## stdout\s*\n+([\s\S]*?)(?:\n##|$)/);
  const stderrMatch = content.match(/## stderr\s*\n+([\s\S]*?)$/);
  const exitMatch = content.match(/exit=(-?\d+)/);
  if (!stdoutMatch && !stderrMatch) {
    return { kind: "plain", content };
  }
  return {
    kind: "shell",
    ...(exitMatch?.[1] !== undefined ? { exitCode: exitMatch[1] } : {}),
    stdout: (stdoutMatch?.[1] ?? "").trim(),
    stderr: (stderrMatch?.[1] ?? "").trim(),
  };
};
