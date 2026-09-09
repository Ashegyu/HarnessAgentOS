import { execFile } from "node:child_process";

export interface CodexMcpInventoryInput {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export const parseCodexMcpServerNames = (stdout: string): string[] => {
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row !== "object" || typeof row.name !== "string" || !row.name.trim())) {
    throw new Error("Invalid Codex MCP inventory");
  }
  return [...new Set(rows.map((row) => row.name as string))];
};

/** mcp list reads effective configuration; it does not start servers or models. */
export const readCodexMcpServerNames = (input: CodexMcpInventoryInput): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile(input.command, ["-c", "features.plugins=false", "-c", "features.apps=false", "mcp", "list", "--json"], {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      ...(input.signal ? { signal: input.signal } : {}),
    }, (error, stdout) => {
      // Do not forward raw config/error output: it can contain connection secrets.
      if (error) { reject(new Error("Codex MCP inventory unavailable")); return; }
      try { resolve(parseCodexMcpServerNames(stdout)); } catch { reject(new Error("Invalid Codex MCP inventory")); }
    });
  });
