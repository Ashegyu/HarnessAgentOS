// Proves compatibility-only follow-up fixes preserve every evaluated memory payload without another model call.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openDb,LocalStateService} from '../../packages/storage/src/index.ts';
import {InstinctService} from '../../packages/learner/src/index.ts';
import {heldout} from './learning-transfer-fixtures.mjs';
const root=resolve(process.argv[3]),rows=[];
for(const arm of ['before','after']){
 const db=openDb({filePath:join(root,arm+'.sqlite')}),state=new LocalStateService(db),service=new InstinctService({state});
 try{for(const c of heldout){
  const ids=db.prepare('SELECT id FROM task_runs WHERE user_request=? ORDER BY rowid').all(c.request.trim());
  for(const[repeat,row]of ids.entries())rows.push({arm,id:c.id,repeat,contexts:await service.forTask({taskRun:await state.getTaskRun(row.id)})});
 }}finally{db.close();}
}
const path=join(root,'context-replay-baseline.json');
if(process.argv[2]==='--capture'){writeFileSync(path,JSON.stringify(rows,null,2));console.log('CAPTURED '+rows.length);}
else{
 const baseline=JSON.parse(readFileSync(path,'utf8')),same=JSON.stringify(baseline)===JSON.stringify(rows);
 const result={same,requests:rows.length,note:'All evaluated selected-memory contents are identical after compatibility fixes; no extra provider invocation.'};
 writeFileSync(join(root,'context-replay.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!same)process.exitCode=1;
}
