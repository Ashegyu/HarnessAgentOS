// Phase 8 smoke — real CLI providers
//
// Runs a tiny `agent.generatePlan` call against whichever provider
// `probeAgentProviders` reports as available. Skipped (exit 0) if no
// provider is installed — that lets CI run the same command on
// machines without claude/codex.
//
// Run:
//   npm run smoke:agent-live
//
// Environment knobs:
//   HARNESS_SMOKE_PROVIDER=claude|codex   force one provider
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

const pickProvider = (probe) => {
  const forced = process.env.HARNESS_SMOKE_PROVIDER;
  if (forced === "claude" || forced === "codex") {
    if (!probe[forced].available) {
      throw new Error(`forced provider ${forced} is not available`);
    }
    return forced;
  }
  if (probe.claude.available) return "claude";
  if (probe.codex.available) return "codex";
  return null;
};

const main = async () => {
  header("live: probing providers");
  const probe = await checkProviders();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(probe, null, 2));
  const provider = pickProvider(probe);
  if (!provider) {
    // eslint-disable-next-line no-console
    console.log("\nSKIP — no CLI provider available. Install `claude` or `codex` to run live smoke.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`\nUsing provider: ${provider}`);

  const timeoutMs = Number(process.env.HARNESS_SMOKE_TIMEOUT_MS ?? 90_000);
  const ctx = bootstrap({ providers: probe });
  // Override defaults so the live CLI gets enough time.
  ctx.agent.defaults = { timeoutMs, stallTimeoutMs: timeoutMs / 2 };

  try {
    const userRequest = process.env.HARNESS_SMOKE_PROMPT ?? DEFAULT_PROMPT;
    header(`live: generatePlan (${provider})`);
    const { draft } = await makeAgentTask(ctx, userRequest);
    const result = await ctx.agent.generatePlan({
      taskRunId: draft.taskRun.id,
      provider,
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
    console.log("\nLIVE SMOKE OK — provider:", provider);
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
