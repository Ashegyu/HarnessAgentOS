import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { McpServerConfig, McpServerHealth } from "@harness/core";

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_ERROR_CHARS = 400;
const STDERR_TAIL_CHARS = 900;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpProbeOptions {
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: typeof globalThis.fetch;
}

export type McpProbe = (
  server: McpServerConfig,
) => Promise<McpServerHealth>;

export const createMcpProbe = (
  options: McpProbeOptions = {},
): McpProbe => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async (server) => {
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    const okResult = (): McpServerHealth => ({ okAt: checkedAt, checkedAt });
    const failResult = (msg: string): McpServerHealth => ({
      error: compactMessage(msg, MAX_ERROR_CHARS),
      checkedAt,
    });

    if (server.transport === "stdio") {
      return probeStdioServer({
        server,
        timeoutMs,
        okResult,
        failResult,
      });
    }

    return probeHttpServer({
      server,
      timeoutMs,
      fetchImpl,
      okResult,
      failResult,
    });
  };
};

export const resolveMcpCommand = async (command: string): Promise<string> => {
  const trimmed = command.trim();
  if (
    trimmed.length === 0 ||
    process.platform !== "win32" ||
    isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return trimmed;
  }

  const pathEntries = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const pathExts = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const lowerCommand = trimmed.toLowerCase();
  const hasKnownExtension = pathExts.some((ext) =>
    lowerCommand.endsWith(ext.toLowerCase()),
  );
  const candidateNames = hasKnownExtension
    ? [trimmed]
    : [trimmed, ...pathExts.map((ext) => `${trimmed}${ext}`)];

  for (const dir of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidate = join(dir, candidateName);
      try {
        await access(candidate, fsConstants.F_OK);
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }

  return trimmed;
};

const probeStdioServer = async ({
  server,
  timeoutMs,
  okResult,
  failResult,
}: {
  server: McpServerConfig;
  timeoutMs: number;
  okResult: () => McpServerHealth;
  failResult: (msg: string) => McpServerHealth;
}): Promise<McpServerHealth> => {
  const command = server.command?.trim() ?? "";
  const args = server.args ? [...server.args] : [];
  if (command.length === 0) return failResult("missing command");

  try {
    const resolvedCommand = await resolveMcpCommand(command);
    const child = spawn(resolvedCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, ...server.env },
    });

    return await new Promise<McpServerHealth>((resolve) => {
      let resolved = false;
      let framedBuffer: Buffer = Buffer.alloc(0);
      let lineBuffer = "";
      let stderrTail = "";
      let timer: NodeJS.Timeout | null = null;

      const appendStderr = (chunk: Buffer): void => {
        stderrTail = compactMessage(
          `${stderrTail}${chunk.toString("utf8")}`,
          STDERR_TAIL_CHARS,
        );
      };

      const withStderr = (message: string): string => {
        const stderr = compactMessage(stderrTail, STDERR_TAIL_CHARS);
        return stderr.length > 0 ? `${message}: ${stderr}` : message;
      };

      const finish = (health: McpServerHealth): void => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already have exited.
        }
        resolve(health);
      };

      const handlePayload = (payload: string): boolean => {
        try {
          const obj = JSON.parse(payload.trim()) as unknown;
          if (obj && typeof obj === "object") {
            finish(okResult());
            return true;
          }
        } catch {
          // Not JSON yet; keep waiting for more stdout.
        }
        return false;
      };

      timer = setTimeout(
        () => finish(failResult(withStderr("probe timeout (3s)"))),
        timeoutMs,
      );

      child.on("error", (e) => {
        finish(failResult(e.message));
      });
      child.on("exit", (code) => {
        if (!resolved) {
          finish(
            code === 0
              ? okResult()
              : failResult(withStderr(`exit ${code ?? "?"}`)),
          );
        }
      });
      child.stderr?.on("data", (b: Buffer) => appendStderr(b));
      child.stdout?.on("data", (b: Buffer) => {
        framedBuffer = Buffer.concat([framedBuffer, b]);
        while (!resolved) {
          const frame = readMcpFrame(framedBuffer);
          if (!frame) break;
          framedBuffer = frame.rest;
          if (frame.payload !== null && handlePayload(frame.payload)) return;
        }
        if (framedBuffer.length > 64_000) {
          framedBuffer = framedBuffer.subarray(framedBuffer.length - 64_000);
        }

        lineBuffer += b.toString("utf8");
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          if (handlePayload(line)) return;
        }
        if (lineBuffer.length > 64_000) {
          lineBuffer = lineBuffer.slice(-64_000);
        }
      });

      const initialize = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "HarnessAgentOS-probe", version: "0" },
        },
      });
      const payloadBytes = Buffer.byteLength(initialize, "utf8");
      try {
        child.stdin?.write(
          `Content-Length: ${payloadBytes}\r\n\r\n${initialize}`,
        );
      } catch (e) {
        finish(failResult(errorMessage(e)));
      }
    });
  } catch (e) {
    return failResult(errorMessage(e));
  }
};

const probeHttpServer = async ({
  server,
  timeoutMs,
  fetchImpl,
  okResult,
  failResult,
}: {
  server: McpServerConfig;
  timeoutMs: number;
  fetchImpl: typeof globalThis.fetch;
  okResult: () => McpServerHealth;
  failResult: (msg: string) => McpServerHealth;
}): Promise<McpServerHealth> => {
  const url = server.url?.trim() ?? "";
  if (url.length === 0) return failResult("missing url");

  const headError = await fetchReachable({
    fetchImpl,
    url,
    method: "HEAD",
    timeoutMs,
  });
  if (headError === null) return okResult();

  const getError = await fetchReachable({
    fetchImpl,
    url,
    method: "GET",
    timeoutMs,
    accept: "text/event-stream, application/json;q=0.9, */*;q=0.8",
  });
  if (getError === null) return okResult();

  return failResult(
    `HEAD failed (${errorMessage(headError)}); GET failed (${errorMessage(
      getError,
    )})`,
  );
};

const fetchReachable = async ({
  fetchImpl,
  url,
  method,
  timeoutMs,
  accept,
}: {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  method: "HEAD" | "GET";
  timeoutMs: number;
  accept?: string;
}): Promise<unknown | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: Parameters<typeof fetchImpl>[1] = {
      method,
      signal: controller.signal,
    };
    if (accept) init.headers = { Accept: accept };
    const res = await fetchImpl(url, init);
    void res.status;
    return null;
  } catch (e) {
    return e;
  } finally {
    clearTimeout(timer);
  }
};

const readMcpFrame = (
  buffer: Buffer,
): { payload: string | null; rest: Buffer } | null => {
  const separator = findHeaderSeparator(buffer);
  if (!separator) return null;

  const header = buffer.subarray(0, separator.index).toString("ascii");
  const match = /content-length:\s*(\d+)/i.exec(header);
  const bodyStart = separator.index + separator.length;
  if (!match?.[1]) {
    return { payload: null, rest: buffer.subarray(bodyStart) };
  }

  const bodyLength = Number(match[1]);
  if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
    return { payload: null, rest: buffer.subarray(bodyStart) };
  }
  if (buffer.length < bodyStart + bodyLength) return null;

  const payload = buffer
    .subarray(bodyStart, bodyStart + bodyLength)
    .toString("utf8");
  return {
    payload,
    rest: buffer.subarray(bodyStart + bodyLength),
  };
};

const findHeaderSeparator = (
  buffer: Buffer,
): { index: number; length: number } | null => {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
};

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) {
    return e.name === "AbortError" ? "probe timeout (3s)" : e.message;
  }
  return String(e);
};

const compactMessage = (message: string, maxChars: number): string => {
  const compact = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return compact.length > maxChars
    ? `${compact.slice(0, maxChars - 3)}...`
    : compact;
};
