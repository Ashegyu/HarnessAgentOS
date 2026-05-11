// claude --output-format=stream-json 출력 형식 측정 + 라인 파싱 검증
import { spawn } from "node:child_process";

const args = [
  "--print",
  "--output-format", "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--no-session-persistence",
  "--model", "claude-sonnet-4-6",
];
const prompt = process.argv[2] ?? "Reply with the single word: pong";

console.log(`claude ${args.join(" ")}\nprompt: ${prompt}\n`);

const t0 = Date.now();
let firstChunkAt = null;
let lineCount = 0;
const lines = [];
const collectedText = [];

const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });

let buffer = "";
child.stdout.on("data", (b) => {
  if (firstChunkAt === null) firstChunkAt = Date.now();
  buffer += b.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    lineCount++;
    lines.push(line);
    try {
      const obj = JSON.parse(line);
      // result 라인의 .result 필드가 최종 텍스트
      if (obj.type === "result" && typeof obj.result === "string") {
        collectedText.push(obj.result);
      }
    } catch {}
  }
});

let stderr = "";
child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });

child.stdin.end(prompt, "utf8");
const code = await new Promise((res) => child.on("close", (c) => res(c ?? -1)));
const total = Date.now() - t0;

console.log(`exit       : ${code}`);
console.log(`total      : ${total}ms`);
console.log(`first chunk: ${firstChunkAt - t0}ms`);
console.log(`json lines : ${lineCount}`);
console.log(`\nExtracted final text:`);
console.log("---");
console.log(collectedText.join(""));
console.log("---");
if (stderr) console.log(`stderr: ${stderr.slice(0, 200)}`);
