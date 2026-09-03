// Live smoke for Codex tool-call telemetry.
//
// This script invokes Codex through DefaultModelCliAdapter and verifies that
// its raw JSONL is normalized into AgentStreamEvent
// { type: "tool_call" }. It uses a synthetic temp fixture so no workspace file
// contents are sent to Codex.
//
// Run:
//   npm --workspace=@harness/desktop run smoke:agent-tool-calls
//
// Environment knobs:
//   HARNESS_SMOKE_TIMEOUT_MS=180000           adapter timeout

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviders } from "../../../packages/agent/src/index.ts";
import { DefaultModelCliAdapter } from "../../../packages/agent/src/model-cli-adapter.ts";

const providerPrompt = () =>
  [
    "Use one read-only tool to inspect fixture.json in the current directory.",
    "Do not modify files. Do not run network commands.",
    "Provider under test: codex.",
    'After the tool call, reply with exactly: {"toolObserved":true}',
  ].join("\n");

const compactToolCall = (event) => ({
  provider: event.provider,
  phase: event.phase,
  toolName: event.toolName,
  ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
  inputType: event.input === null ? "null" : typeof event.input,
});

const makeFixtureDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-tool-smoke-"));
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      name: "hgos-tool-smoke-fixture",
      purpose: "synthetic provider tool-call telemetry smoke",
    }),
    "utf8",
  );
  return dir;
};

const invokeCodex = async (fixtureDir) => {
  const adapter = new DefaultModelCliAdapter();
  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 180_000);
  const events = [];
  const invocationId = `smoke-tool-codex-${Date.now()}`;

  const result = await adapter.invoke(
    {
      invocationId,
      taskRunId: "smoke-tool-call-events",
      cwd: fixtureDir,
      prompt: providerPrompt(),
      modelConfig: {
        provider: "codex",
        model: "gpt-5.6-sol",
        timeoutMs,
        stallTimeoutMs: Math.max(15_000, Math.floor(timeoutMs / 3)),
      },
      sandbox: {
        primaryDir: fixtureDir,
        enforceInPrompt: true,
      },
    },
    (event) => {
      events.push(event);
    },
  );

  const toolCalls = events.filter((event) => event.type === "tool_call");
  const rawCount = events.filter((event) => event.type === "raw").length;
  const assistantText = result.stdout.trim();

  console.log(`\n[codex] exit=${result.exitCode}`);
  console.log(`[codex] cwd=${fixtureDir}`);
  console.log(`[codex] raw events=${rawCount}`);
  console.log(`[codex] tool_call events=${toolCalls.length}`);
  console.log(
    `[codex] assistant=${assistantText.slice(0, 200) || "(empty)"}`,
  );
  if (toolCalls.length > 0) {
    console.log(
      `[codex] first tool_call=${JSON.stringify(compactToolCall(toolCalls[0]))}`,
    );
  }

  if (toolCalls.length === 0) {
    throw new Error("Codex emitted no normalized tool_call events");
  }
};

const main = async () => {
  console.log("=== live: Codex tool-call event smoke ===");
  const probe = await checkProviders({ timeoutMs: 5_000 });
  console.log(JSON.stringify(probe, null, 2));

  if (!probe.codex.available) {
    console.log("\nSKIP - Codex CLI is not available.");
    return;
  }

  const fixtureDir = makeFixtureDir();
  try {
    await invokeCodex(fixtureDir);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log("\nLIVE SMOKE OK - Codex tool_call events observed.");
};

main().catch((error) => {
  console.error(
    "\nLIVE SMOKE FAILED:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
