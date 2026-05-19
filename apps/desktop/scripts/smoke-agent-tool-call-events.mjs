// Live smoke for provider tool-call telemetry.
//
// This script invokes the real CLI provider(s) through DefaultModelCliAdapter
// and verifies that provider raw JSONL is normalized into AgentStreamEvent
// { type: "tool_call" }. It uses a synthetic temp fixture so no workspace file
// contents are sent to external providers.
//
// Run:
//   npm --workspace=@harness/desktop run smoke:agent-tool-calls
//
// Environment knobs:
//   HARNESS_SMOKE_PROVIDER=claude|codex|both  default: both when available
//   HARNESS_SMOKE_TIMEOUT_MS=180000           adapter timeout

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviders } from "../../../packages/agent/src/index.ts";
import { DefaultModelCliAdapter } from "../../../packages/agent/src/model-cli-adapter.ts";

const PROVIDERS = ["claude", "codex"];

const providerPrompt = (provider) =>
  [
    "Use one read-only tool to inspect fixture.json in the current directory.",
    "Do not modify files. Do not run network commands.",
    `Provider under test: ${provider}.`,
    'After the tool call, reply with exactly: {"toolObserved":true}',
  ].join("\n");

const providerModel = (provider) =>
  provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.5";

const selectedProviders = (probe) => {
  const requested = process.env.HARNESS_SMOKE_PROVIDER ?? "both";
  if (requested === "claude" || requested === "codex") return [requested];
  if (requested !== "both") {
    throw new Error(
      "HARNESS_SMOKE_PROVIDER must be claude, codex, or both when set",
    );
  }
  return PROVIDERS.filter((provider) => probe[provider]?.available);
};

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

const invokeProvider = async (provider, fixtureDir) => {
  const adapter = new DefaultModelCliAdapter();
  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 180_000);
  const events = [];
  const invocationId = `smoke-tool-${provider}-${Date.now()}`;

  const result = await adapter.invoke(
    {
      invocationId,
      taskRunId: "smoke-tool-call-events",
      cwd: fixtureDir,
      prompt: providerPrompt(provider),
      modelConfig: {
        provider,
        model: providerModel(provider),
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

  console.log(`\n[${provider}] exit=${result.exitCode}`);
  console.log(`[${provider}] cwd=${fixtureDir}`);
  console.log(`[${provider}] raw events=${rawCount}`);
  console.log(`[${provider}] tool_call events=${toolCalls.length}`);
  console.log(
    `[${provider}] assistant=${assistantText.slice(0, 200) || "(empty)"}`,
  );
  if (toolCalls.length > 0) {
    console.log(
      `[${provider}] first tool_call=${JSON.stringify(compactToolCall(toolCalls[0]))}`,
    );
  }

  if (toolCalls.length === 0) {
    throw new Error(`${provider} emitted no normalized tool_call events`);
  }
};

const main = async () => {
  console.log("=== live: provider tool-call event smoke ===");
  const probe = await checkProviders({ timeoutMs: 5_000 });
  console.log(JSON.stringify(probe, null, 2));

  const providers = selectedProviders(probe);
  if (providers.length === 0) {
    console.log("\nSKIP - no CLI provider available.");
    return;
  }

  const fixtureDir = makeFixtureDir();
  try {
    for (const provider of providers) {
      if (!probe[provider]?.available) {
        throw new Error(`requested provider ${provider} is not available`);
      }
      await invokeProvider(provider, fixtureDir);
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log("\nLIVE SMOKE OK - provider tool_call events observed.");
};

main().catch((error) => {
  console.error(
    "\nLIVE SMOKE FAILED:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
