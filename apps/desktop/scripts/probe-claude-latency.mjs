// Claude CLI 실제 응답 시간 측정 — 사용자 환경에서 stallTimeoutMs 가 합리적인지 확인용
import { spawn } from "node:child_process";

const args = ["--print", "--no-session-persistence", "--model", "claude-sonnet-4-6"];
const prompt = "Reply with the single word: pong";

console.log(`Spawning: claude ${args.join(" ")}`);
console.log(`Prompt: ${prompt}\n`);

const t0 = Date.now();
let firstChunkAt = null;
let stdout = "";
let stderr = "";

const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });

child.stdout.on("data", (b) => {
  if (firstChunkAt === null) firstChunkAt = Date.now();
  stdout += b.toString("utf8");
});
child.stderr.on("data", (b) => {
  stderr += b.toString("utf8");
});

child.stdin.end(prompt, "utf8");

const code = await new Promise((res) => child.on("close", (c) => res(c ?? -1)));
const total = Date.now() - t0;
const firstChunkMs = firstChunkAt ? firstChunkAt - t0 : null;

console.log(`exit code        : ${code}`);
console.log(`total time       : ${total}ms`);
console.log(`first chunk after: ${firstChunkMs}ms`);
console.log(`stdout (${stdout.length} bytes): ${stdout.slice(0, 200)}`);
if (stderr) console.log(`stderr: ${stderr.slice(0, 400)}`);

// 분석
console.log("\n=== Analysis ===");
if (firstChunkMs === null) {
  console.log("FAIL  No stdout at all — claude CLI silently failed");
} else if (firstChunkMs > 30_000) {
  console.log(`FAIL  First chunk took ${firstChunkMs}ms — exceeds default stallTimeoutMs (30s)`);
  console.log("      This explains AGENT_STALL on user environment.");
} else if (firstChunkMs > 10_000) {
  console.log(`WARN  First chunk took ${firstChunkMs}ms — close to default 30s stall timeout`);
} else {
  console.log(`OK    First chunk after ${firstChunkMs}ms`);
}
if (total > 120_000) {
  console.log(`FAIL  Total ${total}ms exceeds default timeoutMs (120s)`);
}
