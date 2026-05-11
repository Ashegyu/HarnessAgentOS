// 사용자 DB 의 최근 agent invocation 상태 조회 (read-only)
// Node 내장 node:sqlite 사용 — better-sqlite3 락 문제 우회
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dbPath = join(process.env.APPDATA, "@harness", "desktop", "app.db");
console.log(`DB: ${dbPath}\n`);

const db = new DatabaseSync(dbPath, { readOnly: true });

const taskRuns = db
  .prepare(
    `SELECT id, user_request, status, created_at, updated_at
     FROM task_runs ORDER BY datetime(created_at) DESC LIMIT 8`,
  )
  .all();
console.log("=== Recent TaskRuns ===");
for (const t of taskRuns) {
  console.log(
    `  [${t.status.padEnd(20)}] ${t.id.slice(0, 20)}  ${(t.user_request ?? "").slice(0, 70)}`,
  );
}

const invocations = db
  .prepare(
    `SELECT id, task_run_id, provider, model, status, error_code, error_message,
            started_at, finished_at, latency_ms
     FROM agent_invocations ORDER BY datetime(started_at) DESC LIMIT 8`,
  )
  .all();
console.log("\n=== Recent Agent Invocations ===");
for (const i of invocations) {
  const dur = i.latency_ms ?? "?";
  console.log(
    `  [${(i.status ?? "?").padEnd(11)}] ${i.provider}:${i.model} ${dur}ms  ${i.error_code ?? ""}  ${(i.error_message ?? "").slice(0, 100)}`,
  );
  console.log(
    `      taskRun=${i.task_run_id.slice(0, 20)}  started=${i.started_at}  finished=${i.finished_at ?? "—"}`,
  );
}

// stalled / running 상태에 갇힌 것 찾기
const stuck = db
  .prepare(
    `SELECT id, task_run_id, provider, status, started_at
     FROM agent_invocations
     WHERE status IN ('queued','running')
     ORDER BY datetime(started_at) DESC`,
  )
  .all();
if (stuck.length > 0) {
  console.log("\n=== STUCK invocations (queued/running) ===");
  for (const s of stuck) {
    console.log(`  ${s.id} (${s.status}) taskRun=${s.task_run_id} started=${s.started_at}`);
  }
} else {
  console.log("\n  (no invocations stuck in queued/running)");
}

db.close();
