/** Opt-in: eight unchanged answers and bounded, host-proven checker corrections under equal arm budgets. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {training,heldout} from './learning-transfer-fixtures.mjs';
import {compileRun,extract} from './learning-transfer.mjs';
import {normalReferenceVariants} from './normal-reference-variants.mjs';
import {openDb,LocalStateService,FilesystemArtifactStore} from '../../packages/storage/src/index.ts';
import {ConversationService,TaskRunCompletionService,readRegressionControlArtifact} from '../../packages/core/src/index.ts';
import {RunnerService} from '../../packages/runners/src/index.ts';
import {QualityEvaluator,RepairLoopService} from '../../packages/quality/src/index.ts';
import {InstinctService} from '../../packages/learner/src/index.ts';
import {AgentPlanningService,DefaultModelCliAdapter,parseAgentPlan} from '../../packages/agent/src/index.ts';
const root=resolve(process.argv[3]??'.cache/learning-executed-repair'),mode=process.argv[2],executionRetry=mode?.endsWith('-progressive')??false,multiReference=(mode?.endsWith('-multi')??false)||executionRetry,compilerRetry=(mode?.endsWith('-compiler')??false)||multiReference,repo=resolve('.'),workspace=join(root,'workspace');
const sha=x=>createHash('sha256').update(x).digest('hex'),read=f=>JSON.parse(readFileSync(join(root,f),'utf8'));
const save=(p,v)=>writeFileSync(join(root,p),JSON.stringify(v,null,2));
const runtimeFiles=['scripts/eval/learning-executed-repair.mjs','scripts/eval/learning-transfer.mjs','scripts/eval/learning-transfer-fixtures.mjs','packages/core/src/regression-control-evidence.ts','packages/core/src/types/regression-contract.ts','packages/core/src/types/failure-lesson.ts','packages/runners/src/regression-contract-service.ts','packages/runners/src/regression-compiler-diagnostics.ts','packages/runners/src/regression-repair-context.ts','packages/runners/src/runner-service.ts','packages/quality/src/repair-loop-service.ts','packages/agent/src/agent-planning-service.ts','packages/agent/src/agent-prompt-builder.ts','packages/agent/src/model-cli-adapter.ts','packages/core/src/redact-secrets.ts','packages/learner/src/failure-learning.ts','packages/learner/src/failure-lesson.ts','packages/learner/src/instinct-service.ts','packages/learner/src/observation-recall.ts'];
const currentSources=()=>[...runtimeFiles,'scripts/eval/normal-reference-variants.mjs','packages/storage/src/repositories/regression-contract-repository.ts','packages/runners/src/regression-failure-identity.ts','packages/core/src/types/validation-run.ts','packages/storage/src/schema.ts','packages/storage/src/migrations.ts','packages/storage/src/repositories/validation-run-repository.ts','packages/storage/src/repositories/repair-attempt-repository.ts','packages/storage/src/quality-failure-signature.ts'].map(path=>({path,sha256:sha(readFileSync(path))}));
export const remainingRepairCalls=(attempts,arm)=>Math.max(0,4-attempts.filter(r=>r.arm===arm).flatMap(r=>r.calls).filter(c=>c.stage!=='initial').length);
export const compilerRetryEligible=r=>!!(r.repairAttempted&&r.repairApprovalIds?.length===1&&!r.compilerRetryAttempted&&r.finalControl?.evidence?.compilationFailure?.phase==='reference'&&r.finalControl.evidence.compilationFailure.diagnostics.some(d=>d.path==='Verification.cs'&&/^CS\d+$/.test(d.code)));
export const executionRetryEligible=r=>!!(r.repairAttempted&&r.repairApprovalIds?.length===1&&!r.secondaryRetryAttempted&&!r.referenceAcceptance?.protected&&/^[a-f0-9]{64}$/.test(r.finalControl?.failureFingerprint??'')&&Number.isSafeInteger(r.finalControl?.evidence?.referenceExitCode)&&r.finalControl.evidence.referenceExitCode!==0&&r.finalControl.evidence.candidateExitCode===undefined);
export const shouldGradeSubmittedAnswer=r=>!!(r.completed&&existsSync(join(r.folder,'initial-candidate.cs'))&&existsSync(join(r.folder,'initial-verification.cs')));
function freeze(){
 if(existsSync(join(root,'repair-protocol.json'))||existsSync(join(root,'repair-attempts.json')))throw Error('Frozen evaluation already exists');
 const base=read('protocol.json');
 if(base.model!=='gpt-5.6-sol'||base.effort!=='medium'||base.repeats!==2)throw Error('Unexpected base conditions');
 const previous=JSON.parse(readFileSync(join(root,'..','learning-transfer-verification-scope','source-manifest.json'),'utf8'));
 if(previous.files.find(f=>f.path==='scripts/eval/learning-transfer-fixtures.mjs')?.sha256!==sha(readFileSync('scripts/eval/learning-transfer-fixtures.mjs')))throw Error('Frozen fixtures changed');
 // Exports/direct-entry handling changed; these exact grading helpers and old score formula are retained.
 const old=execFileSync('git',['show','7d295d2:scripts/eval/learning-transfer.mjs'],{encoding:'utf8'}),now=readFileSync('scripts/eval/learning-transfer.mjs','utf8');
 const helper=s=>s.slice(s.indexOf('function compileRun('),s.indexOf('async function prepare('));
 if(helper(old)!==helper(now))throw Error('Original compilation/extraction helpers changed');
 const controls=[];
 if(multiReference)for(const c of heldout){
  const variants=normalReferenceVariants(c),record={id:c.id,canonicalSha256:sha(c.reference),feedback:{id:variants.feedback.id,sha256:sha(variants.feedback.source)},probe:{id:variants.probe.id,sha256:sha(variants.probe.source)},preflight:{}};
  for(const kind of ['feedback','probe']){const outcome=compileRun(join(root,'normal-control-preflight',c.id,kind),variants[kind].source,c.judge);if(outcome.exitCode!==0||!outcome.groups||!Object.values(outcome.groups).every(Boolean))throw Error('Invalid normal control '+c.id+'/'+kind);record.preflight[kind]=outcome;}
  controls.push(record);
 }
 if(multiReference)save('positive-controls.json',controls);
 save('repair-protocol.json',{...base,maxInitialModelCalls:8,maxRepairModelCalls:8,maxModelCalls:16,maxRepairsPerAnswer:compilerRetry?2:1,maxRepairCallsPerArm:4,compilerRetry,multiReference,executionRetry,
  correction:'Both arms get the same registered trusted reference execution. Only a host-proven reference checker failure may receive one repair call. Never feed candidate-only failure, hidden groups, mutants, scores, or trusted reference source to a repair. Candidate bytes frozen. Approved checker patch only, at most 32 changed lines, then rerun the same contract.',
  constraints:'Original initial request, model, effort, timeout, tools prohibition, training corpus, case/repetition order and scoring retained. User approved extra correction stage and 16-call maximum. No hidden feedback until all generation/correction calls finish. No reruns/tuning.',
  ...(compilerRetry?{compilerRetryPolicy:'Run all eight initial answers and existing primary corrections first. Then allow at most one further correction per answer only for a host-proven compiler diagnostic in Verification.cs after its first approved patch. Both arms retain the same four-call correction budget and global16 maximum. Re-stage frozen inputs and execute a fresh check before retry; never feed hidden grading. If no arm budget remains, retain failure.'}:{}),
  ...(executionRetry?{compilerRetryPolicy:'Superseded by executionRetryPolicy: the second correction can handle compiler or semantic positive-control failures.',executionRetryPolicy:'After all eight initial answers and primary corrections, allow at most one further checker correction per answer for an actual remaining reference failure. Restore exact approved inputs and rerun to obtain fresh host provenance; require matching candidate, reference and checker fingerprints and observed failure identity. Repeated identical failures remain blocked. Both arms share the same per-answer limit 2, per-arm correction limit 4 and total16 calls. Candidate-only failures never qualify; no hidden feedback is provided.'}:{}),
  ...(executionRetry?{correction:'Both arms may receive one primary and one secondary checker correction, subject to the same per-arm4 and global16 limits. Each requires a current host-proven reference failure and a pending approval for one patch of at most 32 changed lines. Preserve the frozen candidate and previous fixes; rerun every registered normal control. Never provide hidden grading or normal implementation source to the model.'}:{}),
  ...(multiReference?{positiveControls:controls.map(({id,canonicalSha256,feedback,probe})=>({id,canonicalSha256,feedback,probe})),referencePolicy:'Both arms use the same canonical and additional normal implementation. All must pass before adoption or candidate execution. References are frozen at registration; failure feedback includes only actual checker outputs and ordered exits, never reference source. The separate unseen normal probe is diagnostic only after every model call; primary 60+40 scoring still uses exactly the original canonical judge and mutants.'}:{}),
  changedFromPriorProtocol:executionRetry?['second correction now covers semantic as well as compiler reference failures, using fresh execution evidence; unchanged equal budgets and primary priority']:multiReference?['two frozen normal implementations per case, equally applied to both arms; every control must pass before adoption']:compilerRetry?['compiler-only second correction within the existing equal four-calls-per-arm budget; all primary corrections have priority']:['host positive-control feedback and a bounded correction stage, equally available to both arms','maximum calls 8 -> 16, explicitly approved by user'],
  unchangedFromPrior:['two problems and two repeats per arm','initial source/request','model/effort/timeouts','60+40 score and hidden graders','three training experiences; no evaluated outputs learned']});
 save('repair-source-manifest.json',{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),createdAt:new Date().toISOString(),files:currentSources(),gradingHelpersUnchanged:true,gradingHelpersSha256:sha(helper(now)),fixtureSha256:sha(readFileSync('scripts/eval/learning-transfer-fixtures.mjs'))});
 save('repair-analysis-plan.json',{createdAt:new Date().toISOString(),beforeModelCalls:true,primary:'New final after versus new final before with identical host correction rules; retain all original initial scores separately.',success:'Report every answer, reference pass and mutant kills, before/after paired delta, correction benefit and failures. Do not claim stable generation unless all after answers are valid across repeats.',replay:{additionalReferenceRunsPerFinalAnswer:5,perProcessTimeoutMs:10000,wholeBudgetMs:120000,neverRescore:true},limits:'Repeated development questions, not fresh blind generalization. Prior no-feedback scores are descriptive only because this run adds a user-approved execution feedback stage.'});
 console.log('FROZEN '+root);
}
async function run(){
 const protocol=read('repair-protocol.json'),manifest=read('repair-source-manifest.json');
 if(Boolean(protocol.multiReference)!==multiReference||Boolean(protocol.compilerRetry)!==compilerRetry||Boolean(protocol.executionRetry)!==executionRetry)throw Error('Execution mode differs from the frozen protocol');
 const assertSources=()=>{if(JSON.stringify(manifest.files)!==JSON.stringify(currentSources()))throw Error('Frozen sources changed');};assertSources();
 if(existsSync(join(root,'repair-attempts.json')))throw Error('Refusing to rerun the frozen evaluation');
 const result={startedAt:new Date().toISOString(),protocolSha256:sha(readFileSync(join(root,'repair-protocol.json'))),modelCalls:0,initialCalls:0,repairCalls:0,attempts:[]};
 const persist=()=>save('repair-attempts.json',result);persist();
 const makeAdapter=(record,getStage)=>({invoke:async(request,onEvent,signal)=>{
   const stage=getStage(),folder=record.folder;
   assertSources();if(stage!=='initial'&&remainingRepairCalls(result.attempts,record.arm)===0)throw Error('Equal arm correction budget exhausted');
   if(++result.modelCalls>16)throw Error('Model call budget exhausted');
   if(stage==='initial'){if(++result.initialCalls>8)throw Error('Initial budget exhausted');}else if(++result.repairCalls>8)throw Error('Repair budget exhausted');persist();
   const pinned={...request,cliPathOverride:'C:/Users/USER/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',modelConfig:{...request.modelConfig,model:protocol.model,reasoningEffort:protocol.effort,timeoutMs:300000,stallTimeoutMs:180000},sandbox:{primaryDir:workspace,mode:'read-only',autoReview:false,readOnlyTask:true,disableWebSearch:true,enforceInPrompt:true}};
   const call={stage,modelCall:result.modelCalls,startedAt:new Date().toISOString(),systemSha256:sha(pinned.systemPrompt??''),userSha256:sha(pinned.prompt)};record.calls.push(call);persist();
   writeFileSync(join(folder,stage+'-request.json'),JSON.stringify({systemPrompt:pinned.systemPrompt,prompt:pinned.prompt,modelConfig:pinned.modelConfig,sandbox:pinned.sandbox},null,2));
   console.log(`MODEL_START ${record.id} ${record.repeat} ${record.arm} ${stage} ${result.modelCalls}/16`);
   const output=await new DefaultModelCliAdapter().invoke(pinned,onEvent,signal);writeFileSync(join(folder,stage+'-raw.txt'),output.stdout);writeFileSync(join(folder,stage+'-provider.jsonl'),output.rawStdout??'');
   call.tools=[];for(const line of(output.rawStdout??'').split('\n')){try{const e=JSON.parse(line);if(e.item?.type&&!['reasoning','agent_message'].includes(e.item.type))call.tools.push(e.item.type);}catch{}}
   if(call.tools.length)throw Error('Protocol violation: model tools used');call.completed=true;call.tokens=output.tokenUsage??null;call.latencyMs=output.latencyMs;persist();console.log(`MODEL_FINISH ${record.id} ${record.repeat} ${record.arm} ${stage}`);return output;
 }});
 for(const[ci,c]of heldout.entries())for(let repeat=0;repeat<2;repeat++)for(const arm of (ci+repeat)%2===0?['before','after']:['after','before']){
  assertSources();const folder=join(root,'attempts',c.id,repeat+'-'+arm);mkdirSync(folder,{recursive:true});
  writeFileSync(join(workspace,'Candidate.cs'),c.seed);
  const db=openDb({filePath:join(root,arm+'.sqlite')}),state=new LocalStateService(db),instinct=new InstinctService({state});
  const settings=await state.getSettings();await state.updateSettings({...settings,activeAgentProfileId:null,agent:{...settings.agent,model:protocol.model,reasoningEffort:protocol.effort,codexWorkspaceWrite:false,codexAutoReview:false}});
  const store=new FilesystemArtifactStore({rootDir:join(folder,'artifacts')}),runner=new RunnerService({state,artifactStore:store}),conversation=new ConversationService({state,pathExists:()=>true}),evaluator=new QualityEvaluator({state}),completion=new TaskRunCompletionService({state});
  const record={id:c.id,repeat,arm,completed:false,repairAttempted:false,calls:[],folder};result.attempts.push(record);persist();let stage='initial',last;
  const primaryAdapter=makeAdapter(record,()=>stage),adapter={invoke:async(...args)=>{last=await primaryAdapter.invoke(...args);return last;}};
  const agent=new AgentPlanningService({state,adapter,getProviderStatus:()=>({codex:{available:true,queueDepth:0}}),getActiveInstincts:({taskRun})=>instinct.forTask({taskRun})});
  const approve=a=>conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});
  try{
   const thread=await state.createThread({title:'HELDOUT '+c.id,targetDir:workspace}),task=await state.createTaskRun({threadId:thread.id,targetDir:workspace,userRequest:c.request,intent:'answer'});
   record.taskRunId=task.id;record.memoryIds=(await instinct.forTask({taskRun:task})).map(i=>i.id);
   await agent.generatePlan({taskRunId:task.id,model:protocol.model,timeoutMs:300000,stallTimeoutMs:180000});
   const parsed=parseAgentPlan(last.stdout);if(!parsed.ok)throw Error('Invalid initial response');const output=extract(parsed.plan.summary);record.completed=true;
   writeFileSync(join(folder,'initial-answer.txt'),parsed.plan.summary);writeFileSync(join(folder,'initial-candidate.cs'),output.Candidate);writeFileSync(join(folder,'initial-verification.cs'),output.Verification);
   const validation=await state.createTaskRun({threadId:thread.id,targetDir:workspace,userRequest:c.request,intent:'change'});record.validationTaskRunId=validation.id;
   for(const[path,after]of [['Candidate.cs',output.Candidate],['Verification.cs',output.Verification]]){
    const step=await state.createStep({taskRunId:validation.id,index:(await state.listStepsByTaskRun(validation.id)).length,kind:'approval',title:'Evaluation submitted source',status:'pending'});
    const cp=await state.createCheckpoint({taskRunId:validation.id,stepId:step.id,reason:'before_edit',stateRef:'{}',summary:'Approved synthetic evaluation input'});
    const a=await state.createApproval({taskRunId:validation.id,checkpointId:cp.id,actionType:'file_write',actionSummary:'Apply submitted '+path,proposedAction:{type:'file_write',filePatch:{path,after}}});await approve(a);await runner.executeApproved(a.id);
   }
   record.inputsApplied=true;
   const ref=join(folder,'reference-input');mkdirSync(ref);writeFileSync(join(ref,'Candidate.cs'),c.reference);
   const additionalReferenceDirs=[];
   if(multiReference){const extra=join(folder,'reference-additional');mkdirSync(extra);writeFileSync(join(extra,'Candidate.cs'),normalReferenceVariants(c).feedback.source);additionalReferenceDirs.push(extra);}
   const contract=await runner.registerRegressionContract({taskRunId:validation.id,title:c.id,referenceDir:ref,...(multiReference?{additionalReferenceDirs}:{}),sourcePaths:['Candidate.cs'],sharedPaths:[],verificationPaths:['Verification.cs'],manualConfirmation:true});record.contractId=contract.id;
   const check=async()=>{const a=await runner.prepareRegressionCheck({taskRunId:validation.id,contractId:contract.id});await approve(a);try{await runner.executeApproved(a.id);}catch(e){if(!/exited/.test(e.message))throw e;}const runs=await state.validationRuns.listByTaskRun(validation.id),r=runs.at(-1);if(!r?.artifactId)throw Error('Missing host execution artifact');const artifact=(await state.listArtifactsByTaskRun(validation.id)).find(a=>a.id===r.artifactId);return{runId:r.id,artifactId:r.artifactId,failureFingerprint:r.failureFingerprint,evidence:readRegressionControlArtifact(await store.read({taskRunId:validation.id,artifactId:r.artifactId,kind:artifact.kind}))};};
   record.initialControl=await check();persist();
   const gate=await evaluator.evaluate({taskRunId:validation.id,requireTests:true});await completion.applyQualityGateResult(gate);
   const context=await runner.getRegressionRepairContext(gate);
   if(context){
    stage='repair';record.repairAttempted=true;record.repairMemoryIds=(await instinct.forTask({taskRun:validation})).map(i=>i.id);persist();
    const repair=new RepairLoopService({state,completion,agentPlanning:agent,maxAttempts:1,getRegressionRepairContext:g=>runner.getRegressionRepairContext(g)});
    try{
     const draft=await repair.createRepairPlan({taskRunId:validation.id,instruction:'This is the host-approved checker correction stage following the original answer. For this stage return a short explanation in summary and exactly one file_patch proposedAction for Verification.cs. Do not repeat Candidate.cs or full C# blocks. Do not use tools. Preserve the candidate and all other checker coverage; '+(executionRetry?'this is the first correction. A fresh failing reference execution may qualify for one further correction within the shared budget.':'there is at most one correction call.')});
     record.repairApprovalIds=draft.approvals.map(a=>a.id);record.repairAttemptId=draft.repairAttemptId;
     if(draft.approvals.length!==1)throw Error('Correction did not yield one validated checker approval');
     await approve(draft.approvals[0]);await runner.executeApproved(draft.approvals[0].id);record.finalControl=await check();
    }catch(e){record.repairError={code:e.code??null,message:e.message};}
   }
   const finalCandidate=readFileSync(join(workspace,'Candidate.cs'),'utf8');record.candidateUnchanged=finalCandidate===output.Candidate;if(!record.candidateUnchanged)throw Error('Correction changed frozen candidate');
   writeFileSync(join(folder,'final-verification.cs'),readFileSync(join(workspace,'Verification.cs'),'utf8'));
  }catch(e){record[record.completed?'validationError':'error']={code:e.code??null,message:e.message};}
  finally{
   if(shouldGradeSubmittedAnswer(record)&&!existsSync(join(folder,'final-verification.cs'))){
    const candidate=readFileSync(join(folder,'initial-candidate.cs'),'utf8');
    record.candidateUnchanged=!record.inputsApplied||readFileSync(join(workspace,'Candidate.cs'),'utf8')===candidate;
    writeFileSync(join(folder,'final-verification.cs'),readFileSync(record.inputsApplied?join(workspace,'Verification.cs'):join(folder,'initial-verification.cs')));
   }
   if(record.contractId){const c=(await state.regressionContracts.list(record.validationTaskRunId)).find(c=>c.id===record.contractId);record.referenceAcceptance={referenceCount:1+(c?.additionalReferenceSources?.length??0),protected:!!c?.protectedVerification,verificationSha256:c?.protectedVerification?.find(s=>s.path==='Verification.cs')?sha(c.protectedVerification.find(s=>s.path==='Verification.cs').content):null};}
   await agent.shutdown();await runner.shutdown();db.close();persist();console.log(`ATTEMPT_FINISH ${c.id} ${repeat} ${arm} correction=${record.repairAttempted}`);
  }
  if(record.error&&/auth|unauthor|401|403|quota|rate.limit|model.*not.*found/i.test(record.error.message))throw Error('Infrastructure failure; no retries');
 }
 if(compilerRetry){
  for(const r of result.attempts.filter(executionRetry?executionRetryEligible:compilerRetryEligible)){
   if(remainingRepairCalls(result.attempts,r.arm)===0){r[executionRetry?'secondaryRetrySkipped':'compilerRetrySkipped']='equal arm correction budget exhausted';persist();continue;}
   if(executionRetry)r.secondaryRetryAttempted=true;else r.compilerRetryAttempted=true;
   r.firstRepairControl=r.finalControl;r.secondaryFailureKind=r.finalControl.evidence.compilationFailure?'compilation':'execution';writeFileSync(join(r.folder,'first-repair-verification.cs'),readFileSync(join(r.folder,'final-verification.cs')));persist();
   const db=openDb({filePath:join(root,r.arm+'.sqlite')}),state=new LocalStateService(db),instinct=new InstinctService({state}),store=new FilesystemArtifactStore({rootDir:join(r.folder,'artifacts')}),runner=new RunnerService({state,artifactStore:store}),conversation=new ConversationService({state,pathExists:()=>true}),completion=new TaskRunCompletionService({state});
   const agent=new AgentPlanningService({state,adapter:makeAdapter(r,()=> executionRetry?'execution-repair':'compiler-repair'),getProviderStatus:()=>({codex:{available:true,queueDepth:0}}),getActiveInstincts:({taskRun})=>instinct.forTask({taskRun})});
   const approve=a=>conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});
   try{
    // Another answer used the workspace. Restore exact inputs by approved writes, then obtain fresh failure provenance.
    for(const[path,file]of [['Candidate.cs','initial-candidate.cs'],['Verification.cs','first-repair-verification.cs']]){
     const step=await state.createStep({taskRunId:r.validationTaskRunId,index:(await state.listStepsByTaskRun(r.validationTaskRunId)).length,kind:'approval',title:'Restore frozen retry input',status:'pending'}),cp=await state.createCheckpoint({taskRunId:r.validationTaskRunId,stepId:step.id,reason:'before_edit',stateRef:'{}',summary:'Approved synthetic input restoration'});
     const a=await state.createApproval({taskRunId:r.validationTaskRunId,checkpointId:cp.id,actionType:'file_write',actionSummary:'Restore exact saved '+path,proposedAction:{type:'file_write',filePatch:{path,after:readFileSync(join(r.folder,file),'utf8')}}});await approve(a);await runner.executeApproved(a.id);
    }
    const check=async()=>{const a=await runner.prepareRegressionCheck({taskRunId:r.validationTaskRunId,contractId:r.contractId});await approve(a);try{await runner.executeApproved(a.id);}catch(e){if(!/exited/.test(e.message))throw e;}const run=(await state.validationRuns.listByTaskRun(r.validationTaskRunId)).at(-1);if(!run?.artifactId)throw Error('Missing retry proof');return{runId:run.id,artifactId:run.artifactId,failureFingerprint:run.failureFingerprint,evidence:readRegressionControlArtifact(await store.read({taskRunId:r.validationTaskRunId,artifactId:run.artifactId,kind:'test_result'}))};};
    const baseline=await check();r[executionRetry?'secondaryRetryBaseline':'compilerRetryBaseline']=baseline;
    if(['verificationFingerprint','candidateFingerprint','referenceFingerprint'].some(k=>baseline.evidence?.[k]!==r.firstRepairControl.evidence?.[k])||(executionRetry?(!baseline.failureFingerprint||baseline.failureFingerprint!==r.firstRepairControl.failureFingerprint||baseline.evidence.referenceExitCode===0||baseline.evidence.candidateExitCode!==undefined):baseline.evidence.compilationFailure?.phase!=='reference'))throw Error('Retry input or observed failure changed');
    const gate=await new QualityEvaluator({state}).evaluate({taskRunId:r.validationTaskRunId,requireTests:true});await completion.applyQualityGateResult(gate);
    const task=await state.getTaskRun(r.validationTaskRunId);r[executionRetry?'secondaryMemoryIds':'compilerMemoryIds']=(await instinct.forTask({taskRun:task})).map(i=>i.id);
    const repair=new RepairLoopService({state,completion,agentPlanning:agent,maxAttempts:2,getRegressionRepairContext:g=>runner.getRegressionRepairContext(g)});
    const draft=await repair.createRepairPlan({taskRunId:r.validationTaskRunId,instruction:executionRetry?'A fresh host execution after the previous checker patch exposed a remaining positive-control failure. Use the current actual diagnostic and contract to repair only that unsupported assertion or compiler error. Return a short summary and exactly one small Verification.cs file_patch. Preserve the first correction and other valid coverage. Do not retarget an assertion to a reference-specific value. No tools or commands; there will be no further retry.':'This is one compiler-diagnostic retry after a previous checker patch. Return a short summary and exactly one small Verification.cs file_patch. Preserve the first correction and all other coverage. No tools or commands; there will be no further retry.'});
    r[executionRetry?'secondaryApprovalIds':'compilerApprovalIds']=draft.approvals.map(a=>a.id);if(draft.approvals.length!==1)throw Error('Retry did not yield one validated approval');
    await approve(draft.approvals[0]);await runner.executeApproved(draft.approvals[0].id);r.finalControl=await check();
   }catch(e){r[executionRetry?'secondaryRetryError':'compilerRetryError']={code:e.code??null,message:e.message};}
   finally{
    r.candidateUnchanged=readFileSync(join(workspace,'Candidate.cs'),'utf8')===readFileSync(join(r.folder,'initial-candidate.cs'),'utf8');writeFileSync(join(r.folder,'final-verification.cs'),readFileSync(join(workspace,'Verification.cs')));
    const c=(await state.regressionContracts.list(r.validationTaskRunId)).find(c=>c.id===r.contractId);r.referenceAcceptance={referenceCount:1+(c?.additionalReferenceSources?.length??0),protected:!!c?.protectedVerification,verificationSha256:c?.protectedVerification?.find(s=>s.path==='Verification.cs')?sha(c.protectedVerification.find(s=>s.path==='Verification.cs').content):null};
    await agent.shutdown();await runner.shutdown();db.close();persist();console.log(`${executionRetry?'EXECUTION':'COMPILER'}_RETRY_FINISH ${r.id} ${r.repeat} ${r.arm}`);
   }
  }
 }
 // Frozen hidden grading begins only after all model work. Nothing here is returned to a model or learner.
 console.log('ALL_MODEL_CALLS_FINISHED; GRADING_START');save('calls-finished.json',{at:new Date().toISOString(),modelCalls:result.modelCalls});
 for(const r of result.attempts){
  const c=heldout.find(c=>c.id===r.id);if(!shouldGradeSubmittedAnswer(r))continue;
  const candidate=readFileSync(join(r.folder,'initial-candidate.cs'),'utf8'),initial=readFileSync(join(r.folder,'initial-verification.cs'),'utf8'),final=readFileSync(join(r.folder,'final-verification.cs'),'utf8');
  const hidden=compileRun(join(r.folder,'hidden'),candidate,c.judge);
  const grade=(program,label)=>{
   const groups=hidden.groups&&Object.values(hidden.groups).every(v=>typeof v==='boolean')?Object.values(hidden.groups):[];
   const correctness=groups.length?60*groups.filter(Boolean).length/groups.length:0,reference=compileRun(join(r.folder,label+'-reference'),c.reference,program),mutants=[];let regression=0;
   if(reference.compiled&&reference.exitCode===0){regression=10;for(const[i,m]of c.mutants.entries()){const check=compileRun(join(r.folder,label+'-mutant-'+i),m,program);mutants.push(check);if(check.compiled&&!check.error&&check.exitCode!==null&&check.exitCode!==0)regression+=10;}}
   return{label,hidden,correctness,regression,reference,mutants,score:Number((correctness+regression).toFixed(2))};
  };
  r.initial=grade(initial,'initial-verifier');
  if(compilerRetry){
    const primary=r.compilerRetryAttempted||r.secondaryRetryAttempted?readFileSync(join(r.folder,'first-repair-verification.cs'),'utf8'):final;
   r.primary=primary===initial?r.initial:grade(primary,'primary-verifier');r.final=primary===final?r.primary:grade(final,'final-verifier');
  }else{r.final=initial===final?{...r.initial,reusedIdenticalVerifier:true}:grade(final,'final-verifier');r.primary=r.final;}
  persist();
 }
 const mean=values=>values.length===4?Number((values.reduce((s,v)=>s+v,0)/values.length).toFixed(2)):null;
 const summary={modelCalls:result.modelCalls,initialCalls:result.initialCalls,repairCalls:result.repairCalls,compilerCalls:result.attempts.flatMap(r=>r.calls).filter(c=>c.stage==='compiler-repair').length,secondaryCalls:result.attempts.flatMap(r=>r.calls).filter(c=>c.stage==='execution-repair').length,validAttempts:result.attempts.filter(r=>r.final).length,initial:{},primary:{},final:{}};
 for(const arm of ['before','after'])for(const stage of ['initial','primary','final'])summary[stage][arm]=mean(result.attempts.filter(r=>r.arm===arm&&r[stage]).map(r=>r[stage].score));
 summary.finalDelta=summary.final.after!==null&&summary.final.before!==null?Number((summary.final.after-summary.final.before).toFixed(2)):null;
 save('repair-summary.json',summary);console.log('RESULT '+JSON.stringify(summary));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(['--freeze','--freeze-compiler','--freeze-multi','--freeze-progressive'].includes(mode))freeze();else if(['--run','--run-compiler','--run-multi','--run-progressive'].includes(mode))await run();else throw Error('Usage: --freeze[-compiler|-multi|-progressive] | --run[-compiler|-multi|-progressive] <prepared fresh directory>');
}
