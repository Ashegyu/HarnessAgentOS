// Live smoke for Codex per-run MCP config overrides.
//
// This script creates a throwaway stdio MCP server, injects it into a real
// `codex exec` invocation with `-c mcp_servers.*`, and verifies two things:
//   1. Codex emitted a normalized tool_call for the smoke MCP tool.
//   2. The raw provider stream includes the marker returned by the MCP server.
//
// Run:
//   npm --workspace=@harness/desktop run smoke:agent-codex-mcp
//
// Environment knobs:
//   HARNESS_SMOKE_TIMEOUT_MS=180000
//   HARNESS_SMOKE_CODEX_MODEL=gpt-5.5

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProviders } from "../../../packages/agent/src/index.ts";
import { buildCodexMcpConfigOverrides } from "../../../packages/agent/src/mcp-config-builder.ts";
import { DefaultModelCliAdapter } from "../../../packages/agent/src/model-cli-adapter.ts";

export const MCP_SMOKE_MARKER = "HARNESS_MCP_SMOKE_OK";
export const MCP_SMOKE_SERVER_NAME = "Harness Smoke";
export const MCP_SMOKE_TOOL_NAME = "harness_smoke_echo";

const currentFile = fileURLToPath(import.meta.url);

export const buildCodexMcpSmokeRequest = ({
  cwd,
  invocationId,
  serverPath,
  timeoutMs,
}) => {
  const now = new Date().toISOString();
  return {
    invocationId,
    taskRunId: "smoke-codex-mcp",
    cwd,
    prompt: [
      "Use the MCP tool named harness_smoke_echo from the harness_smoke server.",
      "The fully qualified tool name may appear as mcp__harness_smoke__harness_smoke_echo.",
      'Call it once with {"message":"codex-mcp-smoke"}.',
      "Do not use shell commands. Do not modify files. Do not access the network.",
      `After the MCP tool result is returned, reply exactly: ${MCP_SMOKE_MARKER}`,
    ].join("\n"),
    systemPrompt: [
      "You are running a HarnessAgentOS live smoke test.",
      "The test passes only if you call the configured MCP smoke tool.",
    ].join("\n"),
    modelConfig: {
      provider: "codex",
      model: process.env.HARNESS_SMOKE_CODEX_MODEL ?? "gpt-5.5",
      timeoutMs,
      stallTimeoutMs: Math.max(15_000, Math.floor(timeoutMs / 3)),
    },
    sandbox: {
      primaryDir: cwd,
      enforceInPrompt: true,
    },
    codexConfigOverrides: buildCodexMcpConfigOverrides([
      {
        id: "mcp_harness_smoke",
        name: MCP_SMOKE_SERVER_NAME,
        description: "Temporary stdio MCP server for Codex live smoke.",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        env: {},
        envSecretRefs: {},
        scope: "global",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]),
  };
};

export const isCodexMcpSmokeToolCall = (event) => {
  if (
    event?.type !== "tool_call" ||
    event.provider !== "codex" ||
    typeof event.toolName !== "string"
  ) {
    return false;
  }
  const name = event.toolName.toLowerCase();
  return (
    name === "mcp_tool_call" ||
    name.includes("harness_smoke") ||
    name.includes("harness-smoke") ||
    name.includes(MCP_SMOKE_TOOL_NAME)
  );
};

export const summarizeCodexMcpSmokeOutcome = ({
  toolCalls,
  rawOutput,
  error,
}) => {
  const smokeToolCalls = toolCalls.filter(isCodexMcpSmokeToolCall);
  if (error) {
    return {
      ok: false,
      reason: `Codex MCP smoke failed before completion: ${error.message ?? error}`,
    };
  }
  if (smokeToolCalls.length === 0) {
    return {
      ok: false,
      reason: `Codex emitted no Harness MCP smoke tool_call. Observed: ${toolCalls.map((event) => event.toolName).join(", ") || "(none)"}`,
    };
  }
  if (!String(rawOutput ?? "").includes(MCP_SMOKE_MARKER)) {
    return {
      ok: false,
      reason: `Codex called the smoke MCP tool but raw output did not include ${MCP_SMOKE_MARKER}.`,
    };
  }
  return {
    ok: true,
    reason:
      "Codex emitted the Harness MCP smoke tool_call and returned the marker.",
  };
};

const compactToolCall = (event) => ({
  provider: event.provider,
  phase: event.phase,
  toolName: event.toolName,
  ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
});

const makeSmokeDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-codex-mcp-smoke-"));
  const serverPath = join(dir, "harness-codex-mcp-smoke-server.mjs");
  writeFileSync(serverPath, SMOKE_MCP_SERVER_SOURCE, "utf8");
  return { dir, serverPath };
};

const invokeCodex = async ({ dir, serverPath }) => {
  const adapter = new DefaultModelCliAdapter();
  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 180_000);
  const events = [];
  const request = buildCodexMcpSmokeRequest({
    cwd: dir,
    invocationId: `smoke-codex-mcp-${Date.now()}`,
    serverPath,
    timeoutMs,
  });

  let result = null;
  let error = null;
  try {
    result = await adapter.invoke(request, (event) => events.push(event));
  } catch (e) {
    error = e;
  }
  return {
    request,
    result,
    error,
    events,
    toolCalls: events.filter((event) => event.type === "tool_call"),
    rawOutput: result?.rawStdout ?? result?.stdout ?? "",
  };
};

const main = async () => {
  console.log("=== live: Codex MCP per-run override smoke ===");
  const probe = await checkProviders({ timeoutMs: 5_000 });
  console.log(JSON.stringify({ codex: probe.codex }, null, 2));
  if (!probe.codex.available) {
    console.log("\nSKIP - Codex CLI provider is not available.");
    return;
  }

  const { dir, serverPath } = makeSmokeDir();
  try {
    console.log(`\nfixtureDir=${dir}`);
    console.log(`server=${serverPath}`);
    const run = await invokeCodex({ dir, serverPath });
    const outcome = summarizeCodexMcpSmokeOutcome(run);
    console.log(`raw events=${run.events.filter((event) => event.type === "raw").length}`);
    console.log(`tool_call events=${run.toolCalls.length}`);
    for (const event of run.toolCalls.slice(0, 5)) {
      console.log(`tool_call=${JSON.stringify(compactToolCall(event))}`);
    }
    if (run.result) {
      console.log(`assistant=${run.result.stdout.trim().slice(0, 300) || "(empty)"}`);
    }
    console.log(`outcome=${outcome.reason}`);
    if (!outcome.ok) {
      throw new Error(outcome.reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nLIVE SMOKE OK - Codex MCP tool_call observed.");
};

export const SMOKE_MCP_SERVER_SOURCE = String.raw`
const TOOL_NAME = "harness_smoke_echo";
const MARKER = "HARNESS_MCP_SMOKE_OK";
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

function readMessages() {
  while (buffer.length > 0) {
    const parsed = readContentLengthFrame() ?? readLineFrame();
    if (!parsed) return;
    buffer = buffer.slice(parsed.bytes);
    handleMessage(parsed.message);
  }
}

function readContentLengthFrame() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = buffer.slice(0, headerEnd).toString("utf8");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;
  return {
    bytes: bodyEnd,
    message: JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")),
  };
}

function readLineFrame() {
  const lineEnd = buffer.indexOf("\n");
  if (lineEnd < 0) return null;
  const raw = buffer.slice(0, lineEnd).toString("utf8").trim();
  if (raw.length === 0) return { bytes: lineEnd + 1, message: null };
  return { bytes: lineEnd + 1, message: JSON.parse(raw) };
}

function handleMessage(message) {
  if (!message || message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "harness-codex-mcp-smoke", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: TOOL_NAME,
          description: "Return a fixed HarnessAgentOS Codex MCP smoke marker.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = MARKER + ":" + String(message.params?.arguments?.message ?? "called");
    respond(message.id, {
      content: [{ type: "text", text }],
      isError: false,
    });
    return;
  }
  respondError(message.id, -32601, "method not found: " + message.method);
}

function respond(id, result) {
  writeFrame({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeFrame({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeFrame(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
`;

if (basename(currentFile) === basename(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(
      "\nLIVE SMOKE FAILED:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
