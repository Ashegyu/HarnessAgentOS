// Phase 8 smoke — FakeModelCliAdapter
//
// Walks the full agent flow without a real CLI: createTask(mode="agent") →
// generatePlan (fake) → cancelInvocation → useTemplateFallback. Exits with
// code 0 only if every assertion passes. Suitable for CI.
//
// Run:
//   npm run smoke:agent-fake
//   (Equivalent: node --import tsx apps/desktop/scripts/smoke-agent-fake.mjs)

import { FakeModelCliAdapter } from "../../../packages/agent/src/index.ts";
import {
  bootstrap,
  makeAgentTask,
  dumpDetail,
  expect,
  header,
} from "./smoke-shared.mjs";

const run = async (scenario, body) => {
  header(`scenario: ${scenario}`);
  const ctx = bootstrap({ adapter: new FakeModelCliAdapter({
    scenario,
    chunkDelayMs: 0,
  }) });
  try {
    await body(ctx);
  } finally {
    ctx.cleanup();
  }
};

const main = async () => {
  // 1. Happy path — file_write action is accepted and approval is created.
  await run("ok-file-write", async (ctx) => {
    const { draft } = await makeAgentTask(ctx, "smoke ok-file-write");
    const result = await ctx.agent.generatePlan({
      taskRunId: draft.taskRun.id,
    });
    const snap = await dumpDetail(ctx, draft.taskRun.id);
    expect(result.invocation.status === "succeeded", "invocation succeeded");
    expect(snap.status === "waiting_for_approval", "task waiting_for_approval");
    expect(snap.approvalCount === 1, "one approval row created");
    expect(snap.artifactKinds.includes("plan"), "plan artifact present");
  });

  // 2. Answer-only path — empty proposedActions short-circuits to
  //    ready_for_review and creates no approvals.
  await run("ok-answer-only", async (ctx) => {
    const { draft } = await makeAgentTask(ctx, "smoke ok-answer-only");
    await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    const snap = await dumpDetail(ctx, draft.taskRun.id);
    expect(snap.status === "ready_for_review", "task ready_for_review");
    expect(snap.approvalCount === 0, "no approvals");
  });

  // 3. Path traversal — adversarial file_write is dropped, policy
  //    report artifact is created, TaskRun still ready_for_review
  //    because no actions survived the filter.
  await run("bad-traversal", async (ctx) => {
    const { draft } = await makeAgentTask(ctx, "smoke bad-traversal");
    await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    const snap = await dumpDetail(ctx, draft.taskRun.id);
    expect(snap.approvalCount === 0, "traversal action rejected");
    expect(
      snap.artifactKinds.includes("quality_report"),
      "policy report artifact created",
    );
  });

  // 4. Parse error — malformed fenced JSON leaves TaskRun in `blocked`
  //    and the invocation is `failed` with AGENT_INVALID_OUTPUT.
  await run("parse-error", async (ctx) => {
    const { draft } = await makeAgentTask(ctx, "smoke parse-error");
    let threw = false;
    try {
      await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    } catch (e) {
      threw = true;
      expect(
        String(e?.code) === "AGENT_INVALID_OUTPUT",
        `error code is AGENT_INVALID_OUTPUT (got ${e?.code})`,
      );
    }
    expect(threw, "generatePlan rejected");
    const snap = await dumpDetail(ctx, draft.taskRun.id);
    expect(snap.status === "blocked", "task blocked");
    expect(
      snap.invocationStatuses[0] === "failed",
      "invocation marked failed",
    );
  });

  // 5. Spawn failure — adapter rejects synchronously; same blocked path.
  await run("spawn-failed", async (ctx) => {
    const { draft } = await makeAgentTask(ctx, "smoke spawn-failed");
    let threw = false;
    try {
      await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    } catch (e) {
      threw = true;
      expect(
        String(e?.code) === "AGENT_SPAWN_FAILED",
        `error code is AGENT_SPAWN_FAILED (got ${e?.code})`,
      );
    }
    expect(threw, "generatePlan rejected on spawn failure");
  });

  // 6. Template fallback after a failed agent invocation — clears
  //    blocked state, creates a deterministic plan + approvals.
  header("scenario: template-fallback-after-failure");
  const ctx = bootstrap({
    adapter: new FakeModelCliAdapter({
      scenario: "parse-error",
      chunkDelayMs: 0,
    }),
  });
  try {
    const { draft } = await makeAgentTask(ctx, "smoke fallback");
    try {
      await ctx.agent.generatePlan({ taskRunId: draft.taskRun.id });
    } catch {
      // expected — fall through
    }
    const before = await dumpDetail(ctx, draft.taskRun.id);
    expect(before.status === "blocked", "task blocked before fallback");

    const fallback = await ctx.conversation.useTemplateFallback({
      taskRunId: draft.taskRun.id,
    });
    const after = await dumpDetail(ctx, draft.taskRun.id);
    expect(
      after.status === "waiting_for_approval",
      "task waiting_for_approval after fallback",
    );
    expect(after.approvalCount >= 1, "fallback created at least one approval");
    expect(fallback.planArtifact.kind === "plan", "fallback plan artifact");
  } finally {
    ctx.cleanup();
  }

  // 7. Cancel — `aborted` scenario waits on AbortSignal; ensure
  //    cancelInvocation tears it down and the row flips to cancelled.
  header("scenario: cancel-during-flight");
  const cancelCtx = bootstrap({
    adapter: new FakeModelCliAdapter({
      scenario: "aborted",
      chunkDelayMs: 0,
    }),
  });
  try {
    const { draft } = await makeAgentTask(cancelCtx, "smoke cancel");
    const generatePromise = cancelCtx.agent
      .generatePlan({ taskRunId: draft.taskRun.id })
      .catch((e) => e);
    // give the queue a tick to start the in-flight work
    await new Promise((r) => setTimeout(r, 30));
    const invocations = await cancelCtx.state.listAgentInvocationsByTaskRun(
      draft.taskRun.id,
    );
    expect(invocations.length === 1, "invocation row exists for cancel test");
    await cancelCtx.agent.cancelInvocation({
      invocationId: invocations[0].id,
    });
    const err = await generatePromise;
    expect(err instanceof Error, "generatePlan rejected after cancel");
    const snap = await dumpDetail(cancelCtx, draft.taskRun.id);
    expect(
      snap.invocationStatuses[0] === "cancelled" ||
        snap.invocationStatuses[0] === "failed",
      `invocation marked terminal (got ${snap.invocationStatuses[0]})`,
    );
  } finally {
    cancelCtx.cleanup();
  }

  if ((process.exitCode ?? 0) === 0) {
    // eslint-disable-next-line no-console
    console.log("\nSMOKE OK — all scenarios passed.");
  } else {
    // eslint-disable-next-line no-console
    console.error("\nSMOKE FAILED — see assertions above.");
  }
};

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("smoke-agent-fake crashed:", e);
  process.exit(1);
});
