import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { openDb, LocalStateService } from "../../packages/storage/src/index.ts";
import { applyMigrations } from "../../packages/storage/src/migrations.ts";

// Isolated, deterministic WAL workload; never uses the app's userData or CLI.
const samples = Number(process.env.HARNESS_BENCH_RUNS ?? 100);
const threads = Number(process.env.HARNESS_BENCH_THREADS ?? 300);
const gates = Number(process.env.HARNESS_BENCH_GATES ?? 100000);
const variant = process.env.HARNESS_BENCH_VARIANT ?? "current";
if (!["baseline", "current"].includes(variant)) throw Error("Invalid variant");
if (![samples, threads, gates].every(n => Number.isSafeInteger(n) && n > 0) || samples > 500 || threads > 1000 || gates > 250000) throw Error("Invalid bounded benchmark sizes");
const root = mkdtempSync(join(tmpdir(), "harness-workbench-load-"));
const db = openDb({ filePath: join(root, "load.db") });
const state = new LocalStateService(db);
// Reproducible comparator on a private DB only: same existing history read,
// without the two new indexes. No checkout rollback or production DB access.
if (variant === "baseline") db.exec("DROP INDEX IF EXISTS idx_quality_gate_results_task; DROP INDEX IF EXISTS idx_task_runs_updated");
const stamp = i => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const summary = "측정용 답변 / synthetic answer ".repeat(40);
try {
  const seedStarted = performance.now();
  db.transaction(() => {
    const thread = db.prepare("INSERT INTO threads(id,title,created_at,updated_at) VALUES (?,?,?,?)");
    const task = db.prepare("INSERT INTO task_runs(id,thread_id,user_request,target_dir,status,created_at,updated_at) VALUES (?,?,?,'C:/synthetic','blocked',?,?)");
    const artifact = db.prepare("INSERT INTO artifacts(id,task_run_id,kind,title,uri,summary,created_at) VALUES (?,?,'log','Agent raw output','harness:bench',?,?)");
    for (let i=0; i<threads; i++) {
      thread.run(`t${i}`, `Thread ${i}`, stamp(i), stamp(i));
      for (let j=0; j<10; j++) {
        const k=i*10+j, id=`r${k}`;
        task.run(id, `t${i}`, `Request ${k}`, stamp(k), stamp(k));
        for (let a=0;a<4;a++) artifact.run(`${id}a${a}`, id, summary, stamp(k*4+a));
      }
    }
    const gate = db.prepare("INSERT INTO quality_gate_results(id,task_run_id,status,known_risks_json,evidence_artifact_ids_json,created_at) VALUES (?,?,'failed','[\"synthetic\"]','[]',?)");
    for (let i=0;i<gates;i++) gate.run(`g${i}`, i < 10 ? "r0" : "r1", stamp(i));
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  const threadRows = await state.listThreads();
  const legacyRecent = async () => (await Promise.all(threadRows.map(t => state.getThreadDetail(t.id))))
    .flatMap(d => d.taskRuns.map(taskRun => ({ taskRun, threadId:d.thread.id, threadTitle:d.thread.title })))
    .sort((a,b)=>b.taskRun.updatedAt.localeCompare(a.taskRun.updatedAt)).slice(0,10);
  const cases = {
    latestQuality: () => state.getLatestQualityGateResult("r0"),
    qualityHistory: () => state.listQualityGateResults("r0"),
    recentCommands: () => variant !== "baseline" && typeof state.listRecentTaskRuns === "function" ? state.listRecentTaskRuns(10) : legacyRecent(),
  };
  const result = { variant, runtime:process.versions, fixture:{threads,tasks:threads*10,artifacts:threads*40,gates,samples,seedMs:performance.now()-seedStarted,dbBytes:statSync(join(root,"load.db")).size}, queries:{}, measurements:{} };
  result.queries.quality = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM quality_gate_results WHERE task_run_id=? ORDER BY rowid DESC LIMIT 1").all("r0");
  for (const [name, run] of Object.entries(cases)) {
    for(let i=0;i<5;i++) await run();
    global.gc?.(); const initial=process.memoryUsage(); let peakHeap=initial.heapUsed, peakRss=initial.rss;
    const timings=[]; let bytes=0;
    for(let i=0;i<samples;i++) {
      const start=performance.now(); const value=await run();
      // Match IPC structured data work with a stable JSON payload proxy.
      bytes=Buffer.byteLength(JSON.stringify(value)); timings.push(performance.now()-start);
      const memory=process.memoryUsage(); peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);
    }
    const sorted=[...timings].sort((a,b)=>a-b), percentile=p=>sorted[Math.ceil(sorted.length*p)-1];
    result.measurements[name]={p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:sorted.at(-1),throughputPerSec:1000*samples/timings.reduce((a,b)=>a+b,0),responseBytes:bytes,peakHeapGrowthBytes:peakHeap-initial.heapUsed,peakRssGrowthBytes:peakRss-initial.rss,timings};
    // End-to-end batch latency, not a sum of independently sampled percentiles.
    const batch=[];
    for(let i=0;i<20;i++) { const start=performance.now(); await Promise.all(Array.from({length:10},run)); batch.push(performance.now()-start); }
    batch.sort((a,b)=>a-b); result.measurements[name].concurrent10={batches:20,p50Ms:batch[9],p95Ms:batch[18],maxMs:batch[19]};
  }
  if (variant === "baseline") {
    const start = performance.now(); applyMigrations(db);
    result.indexUpgradeMs = performance.now() - start;
    db.pragma("wal_checkpoint(TRUNCATE)");
    result.upgradedDbBytes = statSync(join(root, "load.db")).size;
  }
  console.log(JSON.stringify(result));
} finally { db.close(); if (resolve(root).startsWith(resolve(tmpdir())+sep)) rmSync(root,{recursive:true,force:true}); }
