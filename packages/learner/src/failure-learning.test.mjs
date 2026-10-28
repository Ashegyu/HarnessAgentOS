import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDb,LocalStateService,FilesystemArtifactStore} from "@harness/storage";
import {ConversationService} from "@harness/core";
import {RunnerService} from "@harness/runners";
import {QualityEvaluator} from "@harness/quality";
import {InstinctService,ObservationRecallService} from "./index.ts";

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"hgos-failure-learning-"));await mkdir(join(root,"project"));
 const targetDir=join(root,"project");await writeFile(join(targetDir,"Lease.cs"),"public class Lease {} // stale cleanup");
 const db=openDb({filePath:join(root,"state.sqlite")}),state=new LocalStateService(db),artifactStore=new FilesystemArtifactStore({rootDir:join(root,"artifacts")});
 const thread=await state.createThread({title:"training",targetDir});
 const task=await state.createTaskRun({threadId:thread.id,targetDir,userRequest:"C# lease replacement cleanup generation identity",intent:"change"});
 let exitCode=1;
 const runner=new RunnerService({state,artifactStore,shellRunner:{run:async input=>({exitCode,stdout:exitCode?'System.Exception: old lease release removed replacement':'all checks passed',stderr:'',durationMs:1,command:input.command,cwd:input.cwd})}});
 const conversation=new ConversationService({state,pathExists:()=>true});
 const execute=async(details,summary)=>{
  const step=await state.createStep({taskRunId:task.id,index:(await state.listStepsByTaskRun(task.id)).length,kind:"approval",title:summary,status:"pending"});
  const cp=await state.createCheckpoint({taskRunId:task.id,stepId:step.id,reason:"before_shell",stateRef:"{}",summary});
  const a=await state.createApproval({taskRunId:task.id,checkpointId:cp.id,actionType:details.type,actionSummary:summary,proposedAction:details});
  await conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});return runner.executeApproved(a.id);
 };
 const check=()=>execute({type:"shell",command:"node",args:["--test"]},"lease regression");
 const repair=()=>execute({type:"file_write",filePatch:{path:"Lease.cs",after:"public class Lease {} // compare captured lease identity before release"}},"An old lease release must compare captured entry identity before removing a replacement generation");
 const recover=async()=>{await assert.rejects(check());await repair();exitCode=0;await check();return new QualityEvaluator({state}).evaluate({taskRunId:task.id,requireTests:true,requireBuild:false,requireSmoke:false});};
 return{root,targetDir,db,state,artifactStore,task,runner,check,repair,recover,setExit:value=>{exitCode=value;},cleanup:async()=>{await runner.shutdown();db.close();await rm(root,{recursive:true,force:true});}};
}

test("verified repair retains concrete failure, approved rationale, patch and checker provenance exactly once",async()=>{
 const f=await fixture();try{
  const {FailureLearningService}=await import('./failure-learning.ts').catch(()=>({}));
  assert.equal(typeof FailureLearningService,"function","concrete failure learning must exist");
  const service=new FailureLearningService({state:f.state,artifactStore:f.artifactStore});
  await assert.rejects(f.check());assert.deepEqual(await service.recordRecovery({taskRunId:f.task.id}),[]);
  await f.repair();f.setExit(0);await f.check();
  await new QualityEvaluator({state:f.state}).evaluate({taskRunId:f.task.id,requireTests:true,requireBuild:false,requireSmoke:false});
  const [a,b]=await Promise.all([service.recordRecovery({taskRunId:f.task.id}),service.recordRecovery({taskRunId:f.task.id})]);
  if(process.env.HARNESS_LEARNING_DIAGNOSTICS==="1")console.error(JSON.stringify({gate:await f.state.getLatestQualityGateResult(f.task.id),runs:await f.state.validationRuns.listByTaskRun(f.task.id),steps:await f.state.listStepsByTaskRun(f.task.id),approvals:await f.state.listApprovalsByTaskRun(f.task.id)}));
  const rows=await f.state.listObservations({taskRunId:f.task.id});const lessons=rows.filter(x=>x.eventType==="verified_failure_repair");assert.equal(lessons.length,1);
  const lesson=lessons[0].payload.failureLesson;
  assert.match(lesson.symptom,/removed replacement/);assert.match(lesson.repairHypothesis,/captured entry identity/);
  assert.match(lesson.patchExcerpt,/compare captured lease identity/);assert.equal(lesson.causeStatus,"hypothesis");
  assert.notEqual(lesson.failureRunId,lesson.recoveryRunId);assert.ok(a.length+b.length>=1);
  const instinct=new InstinctService({state:f.state});await instinct.refreshCandidates({projectKey:lessons[0].projectKey});
  const candidates=(await instinct.listCandidates({projectKey:lessons[0].projectKey})).filter(c=>c.observationIds.includes(lessons[0].id));assert.equal(candidates.length,1);
  assert.match(candidates[0].proposedRule,/captured entry identity/);
  assert.deepEqual(await instinct.forTask({taskRun:f.task}),[]);
  await instinct.approveCandidate({candidateId:candidates[0].id});
  const selected=await instinct.forTask({taskRun:{...f.task,id:"heldout",userRequest:"C# replace lease then release old lease identity"}});assert.equal(selected.length,1);
  assert.deepEqual(await instinct.forTask({taskRun:{...f.task,id:"other",userRequest:"CSS button color contrast"}}),[]);
  const recall=await new ObservationRecallService({state:f.state}).recall({projectKey:lessons[0].projectKey,query:"captured lease identity",excludeTaskRunId:"heldout"});
  assert.ok(recall.some(x=>x.failureLesson?.recoveryRunId===lesson.recoveryRunId));
  const {buildSplitAgentPrompt}=await import('../../agent/src/agent-prompt-builder.ts');
  const prompt=buildSplitAgentPrompt({taskRun:{...f.task,id:'heldout'},instinctContexts:selected,pinnedObservationContexts:recall});
  assert.match(prompt.userPrompt,/Repair hypothesis, not proven root cause/);assert.match(prompt.userPrompt,/compare captured lease identity/);
  assert.match(prompt.userPrompt,/no execution permission/);
  await instinct.disable({instinctId:selected[0].id,reason:'no longer applicable'});
  assert.deepEqual(await instinct.forTask({taskRun:{...f.task,id:'heldout',userRequest:'lease release replacement identity'}}),[]);
 }finally{await f.cleanup();}
});

test("malformed lessons, generic programming words and conflicting replay identities are rejected",async()=>{
 const {readFailureLesson,lessonTerms}=await import('./failure-lesson.ts');
 assert.equal(readFailureLesson(null),null);assert.equal(readFailureLesson({version:1}),null);
 assert.deepEqual(lessonTerms('public class Dictionary record string values current before after'),[]);
 assert.ok(lessonTerms('LeaseGeneration snapshotEquality').includes('generation'));
 const f=await fixture();try{
  const input={id:'obs_replay',taskRunId:f.task.id,source:'learner',eventType:'verified_failure_repair',signal:'repaired',summary:'original',payload:{}};
  await f.state.createObservation(input);await assert.rejects(f.state.createObservation({...input,summary:'different'}),/idempotency/);
  const candidates=await new InstinctService({state:f.state}).refreshCandidates();assert.deepEqual(candidates,[]);
 }finally{await f.cleanup();}
});

test("missing repair evidence is not promoted and learning failures cannot block quality recording",async()=>{
 const f=await fixture();try{
  const {FailureLearningService}=await import('./failure-learning.ts');const gate=await f.recover();
  const service=new FailureLearningService({state:f.state,artifactStore:{read:async()=>{throw new Error('missing artifact');}}});
  assert.deepEqual(await service.recordRecovery({taskRunId:f.task.id}),[]);
  const instinct=new InstinctService({state:f.state,recordVerifiedRepairs:async()=>{throw new Error('learning unavailable');}});
  const observation=await instinct.recordQualityGate(gate);assert.equal(observation.signal,'passed');
 }finally{await f.cleanup();}
});

test("a prose success, changed workspace or unverified process cannot manufacture a repair lesson",async()=>{
 const f=await fixture();try{
  const {FailureLearningService}=await import('./failure-learning.ts').catch(()=>({}));assert.equal(typeof FailureLearningService,"function");
  const service=new FailureLearningService({state:f.state,artifactStore:f.artifactStore});
  await f.state.createObservation({taskRunId:f.task.id,source:"agent",eventType:"passed",signal:"passed",summary:"fixed all causes"});
  assert.deepEqual(await service.recordRecovery({taskRunId:f.task.id}),[]);
  await f.recover();await writeFile(join(f.targetDir,"Lease.cs"),"changed after successful check");
  assert.deepEqual(await service.recordRecovery({taskRunId:f.task.id}),[]);
 }finally{await f.cleanup();}
});
