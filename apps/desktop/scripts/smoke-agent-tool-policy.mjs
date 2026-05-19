// Live smoke for Claude provider tool-policy enforcement.
//
// Runs two real Claude invocations against a synthetic temp fixture:
// 1. allow: Read is the only allowed tool and must be observed.
// 2. deny: Read is both allowed and denied, so it must not execute.
//
// Run:
//   npm --workspace=@harness/desktop run smoke:agent-tool-policy
//
// Environment knobs:
//   HARNESS_SMOKE_TIMEOUT_MS=180000
//   HARNESS_SMOKE_CLAUDE_MODEL=claude-sonnet-4-6

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkProviders } from "../../../packages/agent/src/index.ts";
import { DefaultModelCliAdapter } from "../../../packages/agent/src/model-cli-adapter.ts";

const DENIED_TOOL_NAME = "Read";
const SIDE_EFFECT_TOOL_DENYLIST = [
  "Bash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Task",
];

const providerModel = () =>
  process.env.HARNESS_SMOKE_CLAUDE_MODEL ?? "claude-sonnet-4-6";

const smokePrompt = (mode) =>
  [
    "This is a HarnessAgentOS synthetic Claude tool-policy smoke test.",
    "Use the Read tool exactly once to read fixture.json from the current directory.",
    "Do not use Bash, Glob, Grep, LS, or any other tool.",
    "Do not modify files. Do not run network commands.",
    mode === "deny"
      ? 'If the Read tool is blocked by policy, reply exactly: {"toolPolicyDenied":true}'
      : 'After the Read tool succeeds, reply exactly: {"toolPolicyAllowed":true}',
  ].join("\n");

export const buildClaudeToolPolicySmokeRequest = ({
  mode,
  fixtureDir,
  invocationId,
  timeoutMs,
}) => ({
  invocationId,
  taskRunId: "smoke-agent-tool-policy",
  cwd: fixtureDir,
  prompt: smokePrompt(mode),
  modelConfig: {
    provider: "claude",
    model: providerModel(),
    timeoutMs,
    stallTimeoutMs: Math.max(15_000, Math.floor(timeoutMs / 3)),
  },
  sandbox: {
    primaryDir: fixtureDir,
    enforceInPrompt: true,
  },
  toolPolicy: {
    toolAllowlist: [DENIED_TOOL_NAME],
    toolDenylist:
      mode === "deny"
        ? [...SIDE_EFFECT_TOOL_DENYLIST, DENIED_TOOL_NAME]
        : [...SIDE_EFFECT_TOOL_DENYLIST],
  },
});

export const isDeniedToolCall = (event, deniedToolName) =>
  event?.type === "tool_call" &&
  typeof event.toolName === "string" &&
  event.toolName.trim().toLowerCase() === deniedToolName.toLowerCase();

export const isPolicyBlockError = (error) => {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/\b(401|unauthorized|authentication|api key|rate limit|quota)\b/i.test(text)) {
    return false;
  }
  return /\b(disallow(?:ed)?|denied|permission|not allowed|forbidden|blocked)\b/i.test(
    text,
  );
};

export const summarizePolicySmokeOutcome = ({
  mode,
  deniedToolName,
  toolCalls,
  error,
}) => {
  const deniedCalls = toolCalls.filter((event) =>
    isDeniedToolCall(event, deniedToolName),
  );
  const sideEffectCalls = toolCalls.filter((event) =>
    SIDE_EFFECT_TOOL_DENYLIST.some((toolName) =>
      isDeniedToolCall(event, toolName),
    ),
  );
  if (sideEffectCalls.length > 0) {
    return {
      ok: false,
      reason: `run emitted side-effect tool_call: ${sideEffectCalls.map((event) => event.toolName).join(", ")}`,
    };
  }
  if (mode === "allow") {
    if (error) {
      return { ok: false, reason: `allow run failed: ${error.message ?? error}` };
    }
    if (deniedCalls.length === 0) {
      return {
        ok: false,
        reason: `allow run did not observe ${deniedToolName} tool_call`,
      };
    }
    return { ok: true, reason: `${deniedToolName} tool_call observed` };
  }

  if (deniedCalls.length > 0) {
    return {
      ok: false,
      reason: `deny run still emitted ${deniedToolName} tool_call`,
    };
  }
  if (error && !isPolicyBlockError(error)) {
    return { ok: false, reason: `deny run failed unexpectedly: ${error.message ?? error}` };
  }
  const otherTools =
    toolCalls.length > 0
      ? `; other observed tool_call(s): ${toolCalls.map((event) => event.toolName).join(", ")}`
      : "";
  return {
    ok: true,
    reason: error
      ? `deny run blocked by provider policy: ${error.message ?? error}`
      : `deny run completed without ${deniedToolName} tool_call${otherTools}`,
  };
};

const compactToolCall = (event) => ({
  provider: event.provider,
  phase: event.phase,
  toolName: event.toolName,
  ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
});

const makeFixtureDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-tool-policy-smoke-"));
  writeFileSync(
    join(dir, "fixture.json"),
    JSON.stringify({
      name: "hgos-tool-policy-smoke-fixture",
      purpose: "synthetic Claude tool policy smoke",
    }),
    "utf8",
  );
  return dir;
};

const invokePolicyMode = async ({ mode, fixtureDir }) => {
  const adapter = new DefaultModelCliAdapter();
  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 180_000);
  const invocationId = `smoke-tool-policy-${mode}-${Date.now()}`;
  const events = [];

  try {
    const result = await adapter.invoke(
      buildClaudeToolPolicySmokeRequest({
        mode,
        fixtureDir,
        invocationId,
        timeoutMs,
      }),
      (event) => {
        events.push(event);
      },
    );
    return { mode, events, result };
  } catch (error) {
    return { mode, events, error };
  }
};

const reportRun = (run) => {
  const toolCalls = run.events.filter((event) => event.type === "tool_call");
  console.log(`\n[claude:${run.mode}] tool_call events=${toolCalls.length}`);
  if (toolCalls[0]) {
    console.log(
      `[claude:${run.mode}] first tool_call=${JSON.stringify(compactToolCall(toolCalls[0]))}`,
    );
  }
  if (run.result) {
    console.log(
      `[claude:${run.mode}] assistant=${run.result.stdout.trim().slice(0, 200) || "(empty)"}`,
    );
  }
  if (run.error) {
    console.log(`[claude:${run.mode}] error=${run.error.message ?? run.error}`);
  }
};

export const main = async () => {
  console.log("=== live: Claude tool policy smoke ===");
  const probe = await checkProviders({ timeoutMs: 5_000 });
  console.log(JSON.stringify(probe, null, 2));
  if (!probe.claude?.available) {
    console.log("\nSKIP - Claude CLI provider is not available.");
    return;
  }

  const fixtureDir = makeFixtureDir();
  try {
    const allowRun = await invokePolicyMode({ mode: "allow", fixtureDir });
    reportRun(allowRun);
    const allowSummary = summarizePolicySmokeOutcome({
      mode: "allow",
      deniedToolName: DENIED_TOOL_NAME,
      toolCalls: allowRun.events.filter((event) => event.type === "tool_call"),
      error: allowRun.error,
    });
    if (!allowSummary.ok) throw new Error(allowSummary.reason);
    console.log(`[claude:allow] ${allowSummary.reason}`);

    const denyRun = await invokePolicyMode({ mode: "deny", fixtureDir });
    reportRun(denyRun);
    const denySummary = summarizePolicySmokeOutcome({
      mode: "deny",
      deniedToolName: DENIED_TOOL_NAME,
      toolCalls: denyRun.events.filter((event) => event.type === "tool_call"),
      error: denyRun.error,
    });
    if (!denySummary.ok) throw new Error(denySummary.reason);
    console.log(`[claude:deny] ${denySummary.reason}`);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log("\nLIVE SMOKE OK - Claude tool policy enforced for Read.");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      "\nLIVE SMOKE FAILED:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
