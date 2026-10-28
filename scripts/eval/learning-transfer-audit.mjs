import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openDb} from '../../packages/storage/src/index.ts';
const root=resolve(process.argv[2]),read=path=>JSON.parse(readFileSync(join(root,path),'utf8'));
const protocol=read('protocol.json'),attempts=read('attempts.json'),training=read('training.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const errors=[],checks=[];
const check=(name,ok)=>{checks.push({name,ok});if(!ok)errors.push(name);};
check('eight fixed-budget attempts',attempts.modelCalls===8&&attempts.attempts.length===8);
check('protocol unchanged',attempts.protocolSha256===sha(readFileSync(join(root,'protocol.json'))));
check('training and held-out cases are disjoint',protocol.trainingIds.every(id=>!protocol.heldoutIds.includes(id)));
for(const id of protocol.heldoutIds)for(let repeat=0;repeat<2;repeat++){
 const pair=attempts.attempts.filter(r=>r.id===id&&r.repeat===repeat),a=pair.find(r=>r.arm==='before'),b=pair.find(r=>r.arm==='after');
 check(`${id}/${repeat} completed without model tools`,!!a?.completed&&!!b?.completed&&a.tools.length===0&&b.tools.length===0);
 const request=arm=>read(join('attempts',id,repeat+'-'+arm,'request.json'));
 const before=request('before'),after=request('after');
 check(`${id}/${repeat} identical system and base user request`,before.systemPrompt===after.systemPrompt&&after.prompt.startsWith(before.prompt+'\n\nACTIVE INSTINCTS\n'));
 check(`${id}/${repeat} identical model, effort, budget and sandbox`,JSON.stringify(before.modelConfig)===JSON.stringify(after.modelConfig)&&JSON.stringify(before.sandbox)===JSON.stringify(after.sandbox));
 check(`${id}/${repeat} only after has approved memory`,a.memoryIds.length===0&&b.memoryIds.length>0&&b.memoryIds.every(x=>training.some(t=>t.instinctId===x)));
}
const db=openDb({filePath:join(root,'after.sqlite')});
try{
 const observations=db.prepare("SELECT task_run_id,payload_json FROM observations WHERE event_type='verified_failure_repair'").all();
 check('held-out outputs never became training observations',observations.length===3&&observations.every(o=>training.some(t=>t.taskRunId===o.task_run_id)));
 for(const t of training){
  const l=t.lesson;
  const failed=db.prepare('SELECT * FROM validation_runs WHERE id=?').get(l.failureRunId),passed=db.prepare('SELECT * FROM validation_runs WHERE id=?').get(l.recoveryRunId);
  check(t.id+' has actual stable failure followed by pass',failed?.exit_code!==0&&failed?.exit_code!==null&&failed?.status==='failed'&&passed?.exit_code===0&&passed?.status==='completed'&&failed.task_run_id===passed.task_run_id&&failed.checker_id===passed.checker_id&&failed.sequence<passed.sequence&&failed.start_fingerprint===failed.finish_fingerprint&&passed.start_fingerprint===passed.finish_fingerprint);
  check(t.id+' cause remains a hypothesis',l.causeStatus==='hypothesis');
 }
}finally{db.close();}
const scoreRows=attempts.attempts.map(r=>({id:r.id,repeat:r.repeat,arm:r.arm,score:r.score,correctness:r.correctness,regression:r.regression,latencyMs:r.latencyMs,tokens:r.tokens,memoryCount:r.memoryIds.length}));
const result={valid:errors.length===0,checks,errors,scoreRows,
 note:'Existing app redaction can mask token-like C# parameter fragments. Requests after the app redaction are verified identical apart from approved memory; no benchmark prompt was changed after calls began.'};
writeFileSync(join(root,'audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({valid:result.valid,checks:checks.length,errors}));
if(!result.valid)process.exitCode=1;
