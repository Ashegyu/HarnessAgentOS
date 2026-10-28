/** Opt-in real-model experiment. --prepare runs only local synthetic C#; --run consumes eight CLI calls once. */
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {training,heldout} from "./learning-transfer-fixtures.mjs";
import {openDb,LocalStateService,FilesystemArtifactStore} from "../../packages/storage/src/index.ts";
import {ConversationService} from "../../packages/core/src/index.ts";
import {RunnerService} from "../../packages/runners/src/index.ts";
import {QualityEvaluator} from "../../packages/quality/src/index.ts";
import {FailureLearningService,InstinctService} from "../../packages/learner/src/index.ts";
import {AgentPlanningService,DefaultModelCliAdapter,parseAgentPlan} from "../../packages/agent/src/index.ts";

const root=resolve(process.argv[3]??".cache/learning-transfer"),mode=process.argv[2];
const workspace=join(root,"workspace"),sha=x=>createHash("sha256").update(x).digest("hex");
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2));
const sourceHash=()=>sha(readFileSync(new URL(import.meta.url))+"\n"+readFileSync(new URL("./learning-transfer-fixtures.mjs",import.meta.url)));
const runtimeFiles=['packages/learner/src/failure-learning.ts','packages/learner/src/failure-lesson.ts','packages/learner/src/instinct-service.ts','packages/learner/src/instinct-candidate-scorer.ts','packages/learner/src/observation-recall.ts','packages/agent/src/agent-prompt-builder.ts'];
const runtimeHash=()=>sha(runtimeFiles.map(p=>p+':'+sha(readFileSync(new URL('../../'+p,import.meta.url)))).join('\n'));
function compileRun(folder,candidate,program){
 mkdirSync(folder,{recursive:true});writeFileSync(join(folder,"Candidate.cs"),candidate);writeFileSync(join(folder,"Program.cs"),program);
 writeFileSync(join(folder,"NuGet.Config"),'<configuration><packageSources><clear /></packageSources></configuration>');
 writeFileSync(join(folder,"Judge.csproj"),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><EnableDefaultCompileItems>false</EnableDefaultCompileItems><UseSharedCompilation>false</UseSharedCompilation><NuGetAudit>false</NuGetAudit></PropertyGroup><ItemGroup><Compile Include="Candidate.cs"/><Compile Include="Program.cs"/></ItemGroup></Project>');
 const started=Date.now();const result=spawnSync('dotnet',['run','--project',join(folder,'Judge.csproj'),'--configuration','Release','--no-launch-profile','-p:ImportDirectoryBuildProps=false','-p:ImportDirectoryBuildTargets=false'],{cwd:folder,encoding:'utf8',timeout:45000,windowsHide:true,env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1',MSBUILDDISABLENODEREUSE:'1'}});
 const output=(result.stdout??'')+(result.stderr??'');writeFileSync(join(folder,'execution.log'),output);
 let groups=null;try{groups=JSON.parse((result.stdout??'').trim().split(/\r?\n/).at(-1));}catch{}
 return{exitCode:result.status,compiled:!(/error (CS|NETSDK|MSB)\d+/.test(output)),error:result.error?.message??null,durationMs:Date.now()-started,groups};
}
function extract(answer){
 const blocks=[...answer.matchAll(/```(?:csharp|cs|c#)\s*\r?\n([\s\S]*?)```/gi)].map(m=>m[1]);const result={};
 for(const name of ['Candidate','Verification']){const found=blocks.filter(b=>new RegExp('^\\s*//\\s*'+name+'\\.cs').test(b));if(found.length!==1)throw Error('Expected exactly one '+name+'.cs block');result[name]=found[0];}
 if(blocks.length!==2)throw Error('Expected exactly two code blocks');return result;
}

async function prepare(){
 if(existsSync(join(root,'protocol.json')))throw Error('Refusing to replace frozen experiment');
 mkdirSync(workspace,{recursive:true});
 for(const c of heldout){
  for(const [i,m]of c.mutants.entries())if(m===c.reference)throw Error('Mutant unchanged '+c.id+'/'+i);
  const good=compileRun(join(root,'preflight',c.id,'reference'),c.reference,c.judge);if(good.exitCode!==0)throw Error('Reference does not pass: '+c.id+' '+JSON.stringify(good));
  for(const[i,m]of c.mutants.entries()){const bad=compileRun(join(root,'preflight',c.id,'mutant-'+i),m,c.judge);if(!bad.compiled||bad.error||bad.exitCode===0)throw Error('Invalid mutant: '+c.id+'/'+i);}
 }
 const beforeDb=openDb({filePath:join(root,'before.sqlite')});new LocalStateService(beforeDb);beforeDb.close();
 const db=openDb({filePath:join(root,'after.sqlite')}),state=new LocalStateService(db),artifactStore=new FilesystemArtifactStore({rootDir:join(root,'training-artifacts')});
 const runner=new RunnerService({state,artifactStore}),conversation=new ConversationService({state,pathExists:()=>true});
 const learning=new FailureLearningService({state,artifactStore}),instinct=new InstinctService({state});
 const records=[];
 try{for(const c of training){
  const referenceDir=join(root,'training-reference',c.id);mkdirSync(referenceDir,{recursive:true});writeFileSync(join(referenceDir,'Candidate.cs'),c.reference);
  writeFileSync(join(workspace,'Candidate.cs'),c.faulty??c.reference);writeFileSync(join(workspace,'Verification.cs'),c.badVerification??c.verification);
  const thread=await state.createThread({title:'TRAIN '+c.id,targetDir:workspace});
  const task=await state.createTaskRun({threadId:thread.id,targetDir:workspace,userRequest:c.query,intent:'change'});
  const contract=await runner.registerRegressionContract({taskRunId:task.id,title:c.id,referenceDir,sourcePaths:['Candidate.cs'],sharedPaths:[],verificationPaths:['Verification.cs'],manualConfirmation:true});
  const check=async()=>{const a=await runner.prepareRegressionCheck({taskRunId:task.id,contractId:contract.id});await conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});return runner.executeApproved(a.id);};
  let failed=false;try{await check();}catch(e){if(!/exited/.test(e.message))throw e;failed=true;}if(!failed)throw Error('Training did not reproduce defect '+c.id);
  const step=await state.createStep({taskRunId:task.id,index:(await state.listStepsByTaskRun(task.id)).length,kind:'approval',title:'reviewed training repair',status:'pending'});
  const cp=await state.createCheckpoint({taskRunId:task.id,stepId:step.id,reason:'before_edit',stateRef:'{}',summary:c.rationale});
  const a=await state.createApproval({taskRunId:task.id,checkpointId:cp.id,actionType:'file_write',actionSummary:c.rationale,
   proposedAction:{type:'file_write',filePatch:{path:c.badVerification?'Verification.cs':'Candidate.cs',after:c.badVerification?c.verification:c.reference}}});
  await conversation.approve({approvalId:a.id,expectedRevision:a.actionRevision,manualConfirmation:true});await runner.executeApproved(a.id);await check();
  const gate=await new QualityEvaluator({state}).evaluate({taskRunId:task.id,requireTests:true,requireBuild:false,requireSmoke:false});if(gate.status!=='passed')throw Error('Training repair did not pass '+JSON.stringify(gate));
  const lessons=await learning.recordRecovery({taskRunId:task.id});if(lessons.length!==1)throw Error('Expected one learned episode '+c.id);
  const projectKey=lessons[0].projectKey;await instinct.refreshCandidates({projectKey});const candidate=(await instinct.listCandidates({projectKey})).find(x=>x.observationIds.includes(lessons[0].id));if(!candidate)throw Error('No lesson candidate');
  // Explicit evaluation setup: approve only synthetic, verified training lessons. Production never auto-approves.
  const approved=await instinct.approveCandidate({candidateId:candidate.id});records.push({id:c.id,taskRunId:task.id,observationId:lessons[0].id,instinctId:approved.id,gate:gate.status,lesson:lessons[0].payload.failureLesson});
  console.log('TRAINING_VERIFIED '+c.id);
 }}finally{await runner.shutdown();db.close();}
 for(const file of ['Candidate.cs','Verification.cs'])rmSync(join(workspace,file),{force:true});
 save(join(root,'training.json'),records);
 save(join(root,'protocol.json'),{version:1,sourceSha256:sourceHash(),runtimeSha256:runtimeHash(),model:'gpt-5.6-sol',effort:'medium',trainingIds:training.map(c=>c.id),heldoutIds:heldout.map(c=>c.id),maxModelCalls:8,repeats:2,
  arms:['before: empty memory','after: three approved evidence-backed training lessons'],order:'counterbalanced per case/repetition',tools:'forbidden, read-only, web/MCP disabled; unexpected tool items invalidate attempts',
  scoring:'60 * hidden groups passed / all groups; 10 for submitted verifier passing reference, then 10 for each of 3 mutants killed. No regression points unless reference passes.',
  constraints:'Same app/model/effort/prompt/budget. Fresh thread per attempt. No grading or learning from held-out outputs until all eight calls finish. No retries or tuning against held-out results.',
  notMeasured:['ChatGPT website','population-level generalization','GUI','model weight training','causal proof of the recorded root-cause hypothesis']});
 console.log('PREPARED '+root);
}

async function run(){
 const protocol=JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'));if(protocol.sourceSha256!==sourceHash()||protocol.runtimeSha256!==runtimeHash())throw Error('Frozen evaluation/runtime code changed');
 if(existsSync(join(root,'attempts.json')))throw Error('Refusing to rerun/tune held-out experiment');
 const result={startedAt:new Date().toISOString(),protocolSha256:sha(readFileSync(join(root,'protocol.json'))),modelCalls:0,attempts:[]};
 const persist=()=>save(join(root,'attempts.json'),result);persist();
 for(const[ci,c]of heldout.entries())for(let repeat=0;repeat<2;repeat++)for(const arm of (ci+repeat)%2===0?['before','after']:['after','before']){
  if(protocol.runtimeSha256!==runtimeHash())throw Error('Runtime changed during frozen evaluation');
  const folder=join(root,'attempts',c.id,repeat+'-'+arm);mkdirSync(folder,{recursive:true});writeFileSync(join(workspace,'Candidate.cs'),c.seed);
  const db=openDb({filePath:join(root,arm+'.sqlite')}),state=new LocalStateService(db),instinct=new InstinctService({state});
  const settings=await state.getSettings();await state.updateSettings({...settings,activeAgentProfileId:null,agent:{...settings.agent,model:protocol.model,reasoningEffort:protocol.effort,codexWorkspaceWrite:false,codexAutoReview:false}});
  const record={id:c.id,repeat,arm,startedAt:new Date().toISOString(),completed:false};result.attempts.push(record);persist();let last;
  const adapter={invoke:async(request,onEvent,signal)=>{
   if(++result.modelCalls>protocol.maxModelCalls)throw Error('Model budget exhausted');persist();
   const pinned={...request,cliPathOverride:'C:/Users/USER/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',
    modelConfig:{...request.modelConfig,model:protocol.model,reasoningEffort:protocol.effort,timeoutMs:300000,stallTimeoutMs:180000},
    sandbox:{primaryDir:workspace,mode:'read-only',readOnlyTask:true,disableWebSearch:true,enforceInPrompt:true}};
   record.systemSha256=sha(pinned.systemPrompt??'');record.userSha256=sha(pinned.prompt);record.requestBytes=Buffer.byteLength((pinned.systemPrompt??'')+pinned.prompt);
   writeFileSync(join(folder,'request.json'),JSON.stringify({systemPrompt:pinned.systemPrompt,prompt:pinned.prompt,modelConfig:pinned.modelConfig,sandbox:pinned.sandbox},null,2));
   console.log('MODEL_START '+c.id+' '+repeat+' '+arm+' '+result.modelCalls+'/8');
   last=await new DefaultModelCliAdapter().invoke(pinned,onEvent,signal);writeFileSync(join(folder,'raw-output.txt'),last.stdout);writeFileSync(join(folder,'provider.jsonl'),last.rawStdout??'');return last;
  }};
  const service=new AgentPlanningService({state,adapter,getProviderStatus:()=>({codex:{available:true,queueDepth:0}}),getActiveInstincts:({taskRun})=>instinct.forTask({taskRun})});
  try{
   const thread=await state.createThread({title:'HELDOUT '+c.id,targetDir:workspace});const task=await state.createTaskRun({threadId:thread.id,targetDir:workspace,userRequest:c.request,intent:'answer'});
   record.memoryIds=(await instinct.forTask({taskRun:task})).map(i=>i.id);await service.generatePlan({taskRunId:task.id,model:protocol.model,timeoutMs:300000,stallTimeoutMs:180000});
   const parsed=parseAgentPlan(last.stdout);if(!parsed.ok)throw Error('App output parse failed');record.answer=parsed.plan.summary;writeFileSync(join(folder,'answer.txt'),record.answer);
   record.tools=[];for(const line of(last.rawStdout??'').split('\n')){try{const e=JSON.parse(line);if(e.item?.type&&!['reasoning','agent_message'].includes(e.item.type))record.tools.push(e.item.type);}catch{}}
   if(record.tools.length)throw Error('Protocol violation: unexpected tools');record.completed=true;record.tokens=last.tokenUsage??null;record.latencyMs=last.latencyMs;
  }catch(e){record.error={code:e.code??null,message:e.message};}
  finally{await service.shutdown();db.close();persist();console.log('MODEL_FINISH '+c.id+' '+repeat+' '+arm+' '+record.completed);}
  if(record.error&&/auth|unauthor|401|403|quota|rate.limit|model.*not.*found/i.test(record.error.message))throw Error('Infrastructure failure; no retries');
 }
 // No feedback is disclosed to either arm, and no held-out outcome is promoted into memory.
 for(const r of result.attempts){if(!r.completed)continue;const c=heldout.find(c=>c.id===r.id),folder=join(root,'attempts',r.id,r.repeat+'-'+r.arm);try{
  const output=extract(r.answer);r.hidden=compileRun(join(folder,'hidden'),output.Candidate,c.judge);
  const groups=r.hidden.groups&&Object.values(r.hidden.groups).every(x=>typeof x==='boolean')?Object.values(r.hidden.groups):[];
  r.correctness=groups.length?60*groups.filter(Boolean).length/groups.length:0;
  r.verifierReference=compileRun(join(folder,'verifier-reference'),c.reference,output.Verification);
  r.regression=0;r.mutants=[];
  if(r.verifierReference.compiled&&r.verifierReference.exitCode===0){r.regression=10;for(const[i,m]of c.mutants.entries()){const check=compileRun(join(folder,'verifier-mutant-'+i),m,output.Verification);r.mutants.push(check);if(check.compiled&&!check.error&&check.exitCode!==null&&check.exitCode!==0)r.regression+=10;}}
  r.score=Number((r.correctness+r.regression).toFixed(2));
 }catch(e){r.gradingError=e.message;r.score=0;}persist();}
 const averages={};for(const arm of ['before','after']){const scored=result.attempts.filter(r=>r.arm===arm&&Number.isFinite(r.score));averages[arm]=scored.length===4?Number((scored.reduce((s,r)=>s+r.score,0)/scored.length).toFixed(2)):null;}
 const summary={averages,delta:averages.before!==null&&averages.after!==null?Number((averages.after-averages.before).toFixed(2)):null,validAttempts:result.attempts.filter(r=>Number.isFinite(r.score)).length,modelCalls:result.modelCalls,
  conclusion:averages.after>averages.before?'improved on this small held-out set':averages.after===averages.before?'no measured improvement on this held-out set':'no improvement; performance declined or experiment incomplete',
  limits:'Two held-out tasks, two repetitions per arm. This does not establish general improvement. The same model weights were used; only approved retrieved experience changed.'};
 save(join(root,'summary.json'),summary);
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 writeFileSync(join(root,'report.html'),'<!doctype html><meta charset="utf-8"><title>Learn 독립 평가</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px;line-height:1.6;background:#101822;color:#e8edf3}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #456;text-align:left}a{color:#9cf}pre{white-space:pre-wrap}</style><h1>Learn·메모리 독립 평가</h1><p>학습 3문제 / 별도 평가 2문제 × 전후 2회 = 모델 호출 8회. 모델·설정·요청·채점 기준 고정.</p><pre>'+esc(JSON.stringify(summary,null,2))+'</pre><table><tr><th>문제</th><th>반복</th><th>조건</th><th>교훈 수</th><th>정확성 /60</th><th>회귀 /40</th><th>총점</th></tr>'+result.attempts.map(r=>'<tr><td>'+esc(r.id)+'</td><td>'+r.repeat+'</td><td>'+r.arm+'</td><td>'+r.memoryIds?.length+'</td><td>'+esc(r.correctness??'invalid')+'</td><td>'+esc(r.regression??'invalid')+'</td><td>'+esc(r.score??r.error?.message)+'</td></tr>').join('')+'</table><p>실제 컴파일·실행 로그는 각 attempts 폴더에 보관. 평가 결과는 교훈 수집에 사용하지 않았습니다. 소규모 결과를 일반적인 성능 향상으로 해석하지 마세요.</p>');
 console.log('RESULT '+JSON.stringify(summary));
}
if(mode==='--prepare')await prepare();else if(mode==='--run')await run();else throw Error('Usage: --prepare or --run <artifact directory>');
