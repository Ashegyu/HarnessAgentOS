import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, LocalStateService } from "../index.ts";
import { applyMigrations } from "../migrations.ts";

test("v42 upgrades the populated store with indexes without changing rows or insertion order", async () => {
  const db=openDb({filePath:":memory:"}),state=new LocalStateService(db);
  try {
    const t=await state.createThread({title:"preserve"});
    const r=await state.createTaskRun({threadId:t.id,targetDir:"C:/fixture",userRequest:"review"});
    await state.createQualityGateResult({id:"existing-gate",taskRunId:r.id,status:"warning",knownRisks:["keep"],evidenceArtifactIds:[],createdAt:"2026-10-27T00:00:00Z"});
    db.exec("DROP INDEX idx_quality_gate_results_task; DROP INDEX idx_task_runs_updated; UPDATE schema_meta SET value='42' WHERE key='schema_version'");
    const before=db.prepare("SELECT * FROM quality_gate_results").all();
    applyMigrations(db);applyMigrations(db);
    assert.deepEqual(db.prepare("SELECT * FROM quality_gate_results").all(),before);
    assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,"43");
    assert.equal((await state.getLatestQualityGateResult(r.id)).id,"existing-gate");
    assert.deepEqual(db.pragma("foreign_key_check"),[]);
  } finally {db.close();}
});

test("quality lookups use task-scoped indexed access with insertion-order latest semantics", async () => {
  const db=openDb({filePath:":memory:"}), state=new LocalStateService(db);
  try {
    const thread=await state.createThread({title:"load"});
    const task=await state.createTaskRun({threadId:thread.id,targetDir:"C:/fixture",userRequest:"review"});
    for(const [id,createdAt] of [["g1","2026-10-27T02:00:00Z"],["g2","2026-10-26T02:00:00Z"]]) await state.createQualityGateResult({id,taskRunId:task.id,status:"failed",knownRisks:[],evidenceArtifactIds:[],createdAt});
    assert.equal((await state.getLatestQualityGateResult(task.id)).id,"g2");
    assert.deepEqual((await state.listQualityGateResults(task.id)).map(g=>g.id),["g1","g2"]);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM quality_gate_results WHERE task_run_id=? ORDER BY rowid DESC LIMIT 1").all(task.id);
    assert.match(plan.map(p=>p.detail).join(" "),/SEARCH quality_gate_results USING INDEX/);
    applyMigrations(db);
    assert.equal((await state.getLatestQualityGateResult(task.id)).id,"g2");
  } finally {db.close();}
});

test("recent task commands limit in SQLite without reading answer artifacts and remain fresh", async () => {
  const db=openDb({filePath:":memory:"}), state=new LocalStateService(db);
  try {
    assert.deepEqual(await state.listRecentTaskRuns(100),[]);
    const a=await state.createThread({title:"renamed later"}), b=await state.createThread({title:"old thread newest task"});
    const tasks=[];
    for(let i=0;i<15;i++) {
      const t=await state.createTaskRun({threadId:i%2?a.id:b.id,targetDir:"C:/fixture",userRequest:`request ${i}`});tasks.push(t);
      db.prepare("UPDATE task_runs SET updated_at=? WHERE id=?").run(new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),t.id);
    }
    state.getThreadDetail=()=>assert.fail("Recent commands must not load thread histories/answers");
    const rows=await state.listRecentTaskRuns(10);
    assert.deepEqual(rows.map(r=>r.taskRun.id),tasks.slice(-10).reverse().map(t=>t.id));
    assert.equal(rows[0].threadId,b.id);assert.equal(rows[0].threadTitle,b.title);
    assert.deepEqual(rows[0].taskRun.contract,tasks.at(-1).contract);
    await state.threads.update(a.id,{title:"fresh title"});
    db.prepare("UPDATE task_runs SET updated_at='2027-01-01T00:00:00Z' WHERE id=?").run(tasks[1].id);
    assert.equal((await state.listRecentTaskRuns(1))[0].threadTitle,"fresh title");
    await state.deleteTaskRun(tasks[1].id);
    assert.equal((await state.listRecentTaskRuns(1))[0].taskRun.id,tasks.at(-1).id);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM task_runs ORDER BY updated_at DESC,rowid DESC LIMIT 10").all();
    assert.match(plan.map(p=>p.detail).join(" "),/USING INDEX/);
    assert.doesNotMatch(plan.map(p=>p.detail).join(" "),/TEMP B-TREE/);
    for(const value of [0,-1,101,NaN,1.5,Infinity]) await assert.rejects(state.listRecentTaskRuns(value));
    assert.deepEqual((await state.listRecentTaskRuns(1)).map(r=>Object.keys(r).sort()),[["taskRun","threadId","threadTitle"]]);
  } finally {db.close();}
});
