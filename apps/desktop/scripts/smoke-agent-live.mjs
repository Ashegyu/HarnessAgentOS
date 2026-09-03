// Phase 8 smoke — real Codex CLI provider
//
// Runs a tiny `agent.generatePlan` call against Codex when it is available.
// Skipped (exit 0) when Codex is not installed so CI can share this command.
//
// Run:
//   npm run smoke:agent-live
//
// Environment knobs:
//   HARNESS_SMOKE_TIMEOUT_MS=60000        adapter timeout (default 90s)
//   HARNESS_SMOKE_PROMPT="..."            override the user request

import { checkProviders } from "../../../packages/agent/src/index.ts";
import {
  bootstrap,
  makeAgentTask,
  dumpDetail,
  expect,
  header,
} from "./smoke-shared.mjs";

const DEFAULT_PROMPT =
  "Echo a one-line summary as JSON harness_agent_plan with no proposed actions.";

const main = async () => {
  header("live: probing Codex");
  const probe = await checkProviders();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(probe, null, 2));
  if (!probe.codex.available) {
    // eslint-disable-next-line no-console
    console.log("\nSKIP — Codex CLI is not available. Install `codex` to run live smoke.");
    process.exit(0);
  }

  const provider = "codex";
  // eslint-disable-next-line no-console
  console.log("\nUsing provider: codex");

  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 90_000);
  const ctx = bootstrap({ providers: probe });
  const stallTimeoutMs = Math.max(5_000, Math.floor(timeoutMs / 2));

  try {
    const userRequest = process.env.HARNESS_SMOKE_PROMPT ?? DEFAULT_PROMPT;
    header(`live: generatePlan (${provider})`);
    const { draft } = await makeAgentTask(ctx, userRequest);
    const result = await ctx.agent.generatePlan({
      taskRunId: draft.taskRun.id,
      provider,
      timeoutMs,
      stallTimeoutMs,
    });
    const snap = await dumpDetail(ctx, draft.taskRun.id);
    expect(
      result.invocation.status === "succeeded",
      `invocation succeeded (got ${result.invocation.status})`,
    );
    expect(
      snap.status === "waiting_for_approval" || snap.status === "ready_for_review",
      `task in terminal-plan state (got ${snap.status})`,
    );
    expect(
      snap.artifactKinds.includes("plan"),
      "plan artifact present",
    );

    // eslint-disable-next-line no-console
    console.log("\nLIVE SMOKE OK — provider: codex");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("\nLIVE SMOKE FAILED:", e?.code ?? "", e?.message ?? e);
    process.exitCode = 1;
  } finally {
    ctx.cleanup();
  }
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("smoke-agent-live crashed:", e);
  process.exit(1);
});
