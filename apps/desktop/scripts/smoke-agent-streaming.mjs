// 실제 claude CLI 를 streaming 모드로 호출해 end-to-end 검증
// (FakeModelCliAdapter 가 아닌 DefaultModelCliAdapter 사용)
//
// 실행:
//   node --import tsx apps/desktop/scripts/smoke-agent-streaming.mjs

import { spawn } from "node:child_process";
import { DefaultModelCliAdapter } from "../../../packages/agent/src/model-cli-adapter.ts";

const adapter = new DefaultModelCliAdapter();

const invokeOnce = async (prompt, sessionId) => {
  const chunks = [];
  const onEvent = (e) => {
    if (e.type === "raw" && e.source === "stdout") chunks.push(e.text);
  };
  const t0 = Date.now();
  const result = await adapter.invoke(
    {
      invocationId: `smoke-stream-${t0}`,
      taskRunId: "smoke-tr-1",
      cwd: process.cwd(),
      prompt,
      modelConfig: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        timeoutMs: 5 * 60_000,
        stallTimeoutMs: 60_000,
      },
      sandbox: { primaryDir: process.cwd(), enforceInPrompt: false },
      ...(sessionId ? { sessionId } : {}),
    },
    onEvent,
  );
  return { result, chunks, durMs: Date.now() - t0 };
};

console.log("[1/2] Initial invocation (new session)...");
const first = await invokeOnce(
  "Remember the phrase '바람과 별' for later. Reply only with 'ok'.",
);
console.log(`  exit=${first.result.exitCode} latency=${first.result.latencyMs}ms chunks=${first.chunks.length}`);
console.log(`  sessionId: ${first.result.sessionId ?? "(none)"}`);
console.log(`  stdout: ${first.result.stdout.slice(0, 120)}`);

if (!first.result.sessionId) {
  console.error("FAIL adapter must surface sessionId from claude stream");
  process.exit(1);
}
if (first.chunks.length < 2) {
  console.error(`FAIL streaming should yield multiple raw chunks — got ${first.chunks.length}`);
  process.exit(1);
}

console.log("\n[2/2] Resume same session and ask about the prior turn...");
const second = await invokeOnce(
  "What phrase did I ask you to remember? Reply with just the phrase.",
  first.result.sessionId,
);
console.log(`  exit=${second.result.exitCode} latency=${second.result.latencyMs}ms chunks=${second.chunks.length}`);
console.log(`  sessionId: ${second.result.sessionId ?? "(none)"}`);
console.log(`  stdout: ${second.result.stdout.slice(0, 200)}`);

if (second.result.exitCode !== 0) {
  console.error("FAIL resume invocation exited non-zero");
  process.exit(1);
}
if (!second.result.stdout.includes("바람과 별")) {
  console.error("FAIL resume did not recall the prior turn — session memory lost");
  process.exit(1);
}
console.log(`\nSMOKE OK — streaming + --resume session memory works.`);
