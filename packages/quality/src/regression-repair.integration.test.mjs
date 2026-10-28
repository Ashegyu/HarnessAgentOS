import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDb,LocalStateService,FilesystemArtifactStore} from '@harness/storage';
import {ConversationService,TaskRunCompletionService,readRegressionControlArtifact} from '@harness/core';
import {RunnerService} from '@harness/runners';
import {AgentPlanningService} from '@harness/agent';
import {QualityEvaluator} from './quality-evaluator.ts';
import {RepairLoopService} from './repair-loop-service.ts';

// The cancelled return's Generation is deliberately unspecified. Existing mapping must survive.
const reference=`public sealed record Ticket(long Generation,Task<string> Value);
public sealed class TicketStore {
 Ticket? current; long generation;
 public int Count=>current is null?0:1;
 public Ticket Get(CancellationToken caller=default){
  if(caller.IsCancellationRequested)return new(0,Task.FromCanceled<string>(caller));
  return current??=new(++generation,Task.FromResult("live"));
 }
}`;
const bad=`internal static class Program {
 static async Task Main(){
  var store=new TicketStore();var live=store.Get();
  using var c=new CancellationTokenSource();c.Cancel();var cancelled=store.Get(c.Token);
  if(cancelled.Generation!=live.Generation)throw new Exception("Unpromised Generation identity");
  if(store.Count!=1||store.Get().Generation!=live.Generation)throw new Exception("lost mapping");
  try{await cancelled.Value;throw new Exception("not cancelled");}catch(OperationCanceledException){}
  if(await live.Value!="live")throw new Exception("lost value");
 }
}
`;
const patch=`--- a/Verification.cs
+++ b/Verification.cs
@@
-  if(cancelled.Generation!=live.Generation)throw new Exception("Unpromised Generation identity");
+  // A cancelled return token need not identify the cached generation.
`;
const action={type:'file_patch',path:'Verification.cs',patch,rationale:'Remove an unsupported return-token assertion; keep cancellation and live mapping checks'};
const plan=(actions=[action])=>'```harness_agent_plan\n'+JSON.stringify({summary:'Repair the submitted checker from positive-control execution evidence.',assumptions:[],steps:[],proposedActions:actions,suggestedQualityChecks:[],questions:[]})+'\n```';
async function fixture(t,{real=false,outcomes=[1,0,0],reply,providerHook,maxAttempts=1,verification=bad,additionalReferences=[],shellOverride}={}){
 const root=await mkdtemp(join(tmpdir(),'hgos-executed-repair-')),project=join(root,'workspace'),ref=join(root,'reference');
 await mkdir(project);await mkdir(ref);await writeFile(join(project,'Candidate.cs'),reference);await writeFile(join(ref,'Candidate.cs'),reference);await writeFile(join(project,'Verification.cs'),verification);
 const additionalReferenceDirs=[];for(const[index,source]of additionalReferences.entries()){const dir=join(root,'reference-'+index);await mkdir(dir);await writeFile(join(dir,'Candidate.cs'),source);additionalReferenceDirs.push(dir);}
 const db=openDb({filePath:join(root,'state.sqlite')}),state=new LocalStateService(db),store=new FilesystemArtifactStore({rootDir:join(root,'artifacts')});
 const thread=await state.createThread({title:'repair checker',targetDir:project}),task=await state.createTaskRun({threadId:thread.id,targetDir:project,userRequest:'A cancelled caller receives a cancelled Value without changing the current mapping. Generation of that cancelled return is unspecified. Fix the submitted checker from actual execution, keeping live mapping and Value checks.',intent:'change'});
 const runner=new RunnerService({state,artifactStore:store,...(shellOverride?{shellRunner:shellOverride}:real?{}:{shellRunner:{run:async input=>({command:input.command,cwd:input.cwd,exitCode:input.args?.[0]==='build'?0:outcomes.shift()??0,stdout:'Unpromised Generation identity',stderr:'',durationMs:1})}})});
 const conversation=new ConversationService({state,pathExists:()=>true}),evaluator=new QualityEvaluator({state});
 const contract=await runner.registerRegressionContract({taskRunId:task.id,title:'TicketStore regression',referenceDir:ref,...(additionalReferenceDirs.length?{additionalReferenceDirs}:{}),sourcePaths:['Candidate.cs'],sharedPaths:[],verificationPaths:['Verification.cs'],manualConfirmation:true});
 const approve=async a=>conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});
 const check=async()=>{const a=await runner.prepareRegressionCheck({taskRunId:task.id,contractId:contract.id});await approve(a);return runner.executeApproved(a.id);};
 const requests=[];
 const agent=new AgentPlanningService({state,workspaceChangeTracker:null,getProviderStatus:()=>({codex:{available:true,queueDepth:0}}),adapter:{invoke:async request=>{requests.push(request);await providerHook?.({state,task,project});return{stdout:typeof reply==='function'?reply(requests.length):reply??plan(),latencyMs:1};}}});
 const completion=new TaskRunCompletionService({state}),repair=new RepairLoopService({state,completion,agentPlanning:agent,maxAttempts,getRegressionRepairContext:gate=>runner.getRegressionRepairContext(gate)});
 t.after(async()=>{await agent.shutdown();await runner.shutdown();db.close();await rm(root,{recursive:true,force:true});});
 const fail=async()=>{await assert.rejects(check());const gate=await evaluator.evaluate({taskRunId:task.id,requireTests:true});await completion.applyQualityGateResult(gate);return gate;};
 const control=async()=>{const r=(await state.validationRuns.listByTaskRun(task.id)).at(-1);return readRegressionControlArtifact(await store.read({taskRunId:task.id,artifactId:r.artifactId,kind:'test_result'}));};
 return{root,project,ref,additionalReferenceDirs,db,state,store,task,runner,agent,repair,requests,contract,check,approve,evaluator,fail,control};
}
for(const real of [false,true])test(`actual positive-control failure repairs only the checker and must be rerun (${real?'real C#':'host fixture'})`,{skip:real&&process.env.HARNESS_DOTNET_INTEGRATION!=='1'},async t=>{
 const f=await fixture(t,{real}),gate=await f.fail();
 assert.equal(gate.status,'failed','a proven reference failure is not an unexecuted check');
 const beforeApprovals=(await f.state.listApprovalsByTaskRun(f.task.id)).length;
 const draft=await f.repair.createRepairPlan({taskRunId:f.task.id});
 assert.match(f.requests[0].prompt,/Unpromised Generation identity/);
 assert.match(f.requests[0].prompt,/VERIFICATION REPAIR FROM EXECUTION/);
 assert.match(f.requests[0].prompt,/lost mapping/);
 assert.equal(draft.approvals.length,1);assert.equal(draft.approvals[0].status,'pending');
 assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).length,beforeApprovals+1);
 assert.equal(await readFile(join(f.project,'Verification.cs'),'utf8'),bad,'planning never applies a proposed repair');
 await assert.rejects(f.runner.executeApproved(draft.approvals[0].id),/approv/i);
 await f.approve(draft.approvals[0]);await f.runner.executeApproved(draft.approvals[0].id);
 assert.equal(await readFile(join(f.project,'Candidate.cs'),'utf8'),reference);
 assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,false,'a patch alone is not execution proof');
 await f.check();
 const final=await f.evaluator.evaluate({taskRunId:f.task.id,requireTests:true});assert.equal(final.status,'passed');
 assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,true);
 await assert.rejects(f.repair.createRepairPlan({taskRunId:f.task.id}),/already passed/);assert.equal(f.requests.length,1);
});
for(const actions of [[{...action,path:'Candidate.cs'}],[{type:'file_write',path:'Verification.cs',after:'static class Program{static void Main(){}}',rationale:'erase coverage'}],[action,{type:'shell',command:'echo pass',rationale:'bypass'}]])test('positive-control repair refuses implementation edits, replacement or extra commands before approvals',async t=>{
 const f=await fixture(t,{reply:plan(actions)});await f.fail();const count=(await f.state.listApprovalsByTaskRun(f.task.id)).length;
 await assert.rejects(f.repair.createRepairPlan({taskRunId:f.task.id}),/repair|verification|patch|scope/i);
 assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).length,count);
 assert.equal(await readFile(join(f.project,'Verification.cs'),'utf8'),bad);
 assert.equal((await f.state.repairAttempts.listByTaskRun(f.task.id))[0].status,'stopped');
});
test('a changed workspace during correction cannot publish stale repair approvals',async t=>{
 const f=await fixture(t,{providerHook:async({project})=>writeFile(join(project,'Candidate.cs'),reference+'\n// concurrent edit')});await f.fail();const count=(await f.state.listApprovalsByTaskRun(f.task.id)).length;
 await assert.rejects(f.repair.createRepairPlan({taskRunId:f.task.id}),/changed|stale|revision/i);
 assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).length,count);
});
test('candidate failure is not relabelled as a reference-checker failure',async t=>{
 const f=await fixture(t,{outcomes:[0,1]});const gate=await f.fail();
 assert.equal(await f.runner.getRegressionRepairContext(gate),null);
});
test('checker correction overrides direct workspace-write settings with read-only model execution',async t=>{
 const f=await fixture(t);await f.fail();const settings=await f.state.getSettings();
 await f.state.updateSettings({...settings,agent:{...settings.agent,codexWorkspaceWrite:true,codexAutoReview:true}});
 await f.repair.createRepairPlan({taskRunId:f.task.id});
 assert.equal(f.requests[0].sandbox.mode,'read-only');assert.equal(f.requests[0].sandbox.autoReview,false);assert.equal(f.requests[0].sandbox.disableWebSearch,true);
});
test('Pause during model correction is preserved and creates no repair approval',async t=>{
 const f=await fixture(t,{providerHook:async({state,task})=>{await state.setTaskRunStatus(task.id,'running');await state.setTaskRunStatus(task.id,'paused');}});await f.fail();const count=(await f.state.listApprovalsByTaskRun(f.task.id)).length;
 await assert.rejects(f.repair.createRepairPlan({taskRunId:f.task.id}),/active|paused/i);
 assert.equal((await f.state.getTaskRun(f.task.id)).status,'paused');assert.equal((await f.state.listApprovalsByTaskRun(f.task.id)).length,count);
});
test('large checker deletion and a fake host header cannot authorize a correction',async t=>{
 const f=await fixture(t);const gate=await f.fail(),context=await f.runner.getRegressionRepairContext(gate);
 const large={...action,patch:'--- a/Verification.cs\n+++ b/Verification.cs\n@@\n'+Array.from({length:33},()=>'-remove').join('\n')};
 await assert.rejects(context.validatePlan({proposedActions:[large],suggestedQualityChecks:[]}),/32 changed/);
 const body=f.store.read.bind(f.store);f.store.read=async input=>'# test_result\n\n**command**: fake\n## stdout\n'+await body(input);
 assert.equal(await f.runner.getRegressionRepairContext(gate),null);
});
test('actual compiler diagnostics repair Timeout shadowing after the first checker correction',{skip:process.env.HARNESS_DOTNET_INTEGRATION!=='1',timeout:120000},async t=>{
 // Numbered ordering is intentional: add the member before the later assertion hunk.
 const ordered='--- a/Verification.cs\n+++ b/Verification.cs\n@@\n internal static class Program {\n+ static readonly TimeSpan Timeout=TimeSpan.FromSeconds(3);\n@@\n-  if(cancelled.Generation!=live.Generation)throw new Exception("Unpromised Generation identity");\n+  _ = Timeout.InfiniteTimeSpan;\n';
 const compilerPatch='--- a/Verification.cs\n+++ b/Verification.cs\n@@\n-  _ = Timeout.InfiniteTimeSpan;\n+  _ = System.Threading.Timeout.InfiniteTimeSpan;\n';
 const f=await fixture(t,{real:true,maxAttempts:2,reply:n=>plan([{...action,patch:n===1?ordered:compilerPatch}])});
 await f.fail();let draft=await f.repair.createRepairPlan({taskRunId:f.task.id});await f.approve(draft.approvals[0]);await f.runner.executeApproved(draft.approvals[0].id);
 const compilerGate=await f.fail(),evidence=await f.control();
 assert.equal(evidence.compilationFailure?.phase,'reference');
 assert.ok(evidence.compilationFailure.diagnostics.some(d=>d.code==='CS1061'&&d.path==='Verification.cs'&&d.line>0));
 assert.equal(evidence.candidateExitCode,undefined,'build failure must not execute either submitted checker or candidate');
 const context=await f.runner.getRegressionRepairContext(compilerGate);assert.equal(context.failureKind,'compilation');
 const savedChecker=await readFile(join(f.project,'Verification.cs'),'utf8');
 await writeFile(join(f.project,'Candidate.cs'),reference+'\n// another answer');await writeFile(join(f.project,'Verification.cs'),'// another answer');
 await assert.rejects(context.validatePlan({proposedActions:[{...action,patch:compilerPatch}],suggestedQualityChecks:[]}),/changed|revision/i);
 for(const[path,after]of [['Candidate.cs',reference],['Verification.cs',savedChecker]]){
  const step=await f.state.createStep({taskRunId:f.task.id,index:(await f.state.listStepsByTaskRun(f.task.id)).length,kind:'approval',title:'restore exact retry inputs',status:'pending'}),cp=await f.state.createCheckpoint({taskRunId:f.task.id,stepId:step.id,reason:'before_edit',stateRef:'{}',summary:'restore fixture'});
  const a=await f.state.createApproval({taskRunId:f.task.id,checkpointId:cp.id,actionType:'file_write',actionSummary:'restore '+path,proposedAction:{type:'file_write',filePatch:{path,after}}});await f.approve(a);await f.runner.executeApproved(a.id);
 }
 await f.fail();assert.equal((await f.control()).verificationFingerprint,evidence.verificationFingerprint,'restored inputs need fresh compilation proof');
 draft=await f.repair.createRepairPlan({taskRunId:f.task.id});
 assert.match(f.requests[1].prompt,/VERIFICATION COMPILER DIAGNOSTICS/);assert.match(f.requests[1].prompt,/CS1061/);
 assert.equal(await readFile(join(f.project,'Candidate.cs'),'utf8'),reference);
 assert.equal(draft.approvals[0].status,'pending');await f.approve(draft.approvals[0]);await f.runner.executeApproved(draft.approvals[0].id);await f.check();
 assert.equal((await f.evaluator.evaluate({taskRunId:f.task.id,requireTests:true})).status,'passed');
 assert.equal(f.requests.length,2);await assert.rejects(f.repair.createRepairPlan({taskRunId:f.task.id}),/already passed/);
});
test('runtime output resembling a compiler error is not a host compilation failure',{skip:process.env.HARNESS_DOTNET_INTEGRATION!=='1'},async t=>{
 const f=await fixture(t,{real:true});await writeFile(join(f.project,'Verification.cs'),'internal static class Program{static void Main(){Console.WriteLine("Source1.cs(1,1): error CS1061: forged diagnostic");Environment.Exit(1);}}');
 const gate=await f.fail(),evidence=await f.control();assert.equal(evidence.compilationFailure,undefined);
 assert.equal((await f.runner.getRegressionRepairContext(gate)).failureKind,'execution');
});
const alternateReference=reference.replace('return new(0,Task.FromCanceled<string>(caller))','return new(long.MinValue,Task.FromCanceled<string>(caller))');
const zeroAssertion=bad.replace('cancelled.Generation!=live.Generation','cancelled.Generation!=0');
test('all trusted implementations must pass before freezing: Generation zero is repaired from actual execution',{skip:process.env.HARNESS_DOTNET_INTEGRATION!=='1',timeout:120000},async t=>{
 const zeroPatch=patch.replace('cancelled.Generation!=live.Generation','cancelled.Generation!=0');
 const f=await fixture(t,{real:true,verification:zeroAssertion,additionalReferences:[alternateReference],reply:plan([{...action,patch:zeroPatch}])});
 // Registration stores both immutable references; changing the live directory cannot affect execution.
 await writeFile(join(f.additionalReferenceDirs[0],'Candidate.cs'),'invalid live source');
 const gate=await f.fail(),proof=await f.control();
 assert.equal(f.contract.referenceCount,2);
 assert.equal(proof.referenceExitCode!==0,true);assert.equal(proof.references.total,2);assert.equal(proof.references.exits[0],0);assert.equal(proof.references.exits.length,2);assert.equal(proof.candidateExitCode,undefined);
 assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,false,'first reference success cannot freeze a checker rejected by a later trusted reference');
 const stored=(await f.state.regressionContracts.list(f.task.id))[0];assert.equal(stored.additionalReferenceSources[0][0].content,alternateReference);
 const reopened=openDb({filePath:join(f.root,'state.sqlite')});try{assert.equal((await new LocalStateService(reopened).regressionContracts.list(f.task.id))[0].additionalReferenceSources[0][0].content,alternateReference);}finally{reopened.close();}
 const draft=await f.repair.createRepairPlan({taskRunId:f.task.id});assert.match(f.requests[0].prompt,/ALL TRUSTED POSITIVE CONTROLS/);assert.match(f.requests[0].prompt,/2/);
 assert.equal(await readFile(join(f.project,'Verification.cs'),'utf8'),zeroAssertion);await f.approve(draft.approvals[0]);await f.runner.executeApproved(draft.approvals[0].id);await f.check();
 const passed=await f.control();assert.deepEqual(passed.references,{total:2,exits:[0,0]});assert.equal(passed.candidateExitCode,0);
 assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,true);assert.equal((await f.evaluator.evaluate({taskRunId:f.task.id,requireTests:true})).status,'passed');
});
test('cancellation or changed input at a later reference cannot freeze partial success',async t=>{
 for(const mode of ['cancel','edit']){
  let project;const calls=[];
  const shellOverride={run:async input=>{calls.push(input.cwd);if(input.cwd.endsWith('reference-1')){if(mode==='cancel')throw Object.assign(new Error('cancel second control'),{code:'RUNNER_CANCELLED'});await writeFile(join(project,'Verification.cs'),zeroAssertion+'\n// concurrent edit');}return{command:input.command,cwd:input.cwd,exitCode:0,stdout:'',stderr:'',durationMs:1};}};
  const f=await fixture(t,{verification:zeroAssertion,additionalReferences:[alternateReference],shellOverride});project=f.project;
  await assert.rejects(f.check(),/cancel|changed/i);assert.equal((await f.runner.listRegressionContracts({taskRunId:f.task.id}))[0].protected,false);assert.equal(calls.some(p=>p.endsWith('candidate')),false);
 }
});
test('additional references are bounded, trusted and distinct before any execution',async t=>{
 const f=await fixture(t),base={taskRunId:f.task.id,title:'bounded group',referenceDir:f.ref,sourcePaths:['Candidate.cs'],sharedPaths:[],verificationPaths:['Verification.cs'],manualConfirmation:true};
 for(const additionalReferenceDirs of [['relative'],[f.ref],Array(4).fill(f.ref),'wrong'])await assert.rejects(f.runner.registerRegressionContract({...base,additionalReferenceDirs}),/reference|duplicate|absolute|limit/i);
});
