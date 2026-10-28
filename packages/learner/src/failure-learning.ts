import {createHash} from "node:crypto";
import {selectCurrentValidationEvidence,type ArtifactStore,type FailureLesson,type Observation} from "@harness/core";
import type {LocalStateService} from "@harness/storage";
import {deriveProjectKey} from "./project-key.ts";
import {redactSecrets} from "./redact-secrets.ts";
import {lessonTerms,observationLesson} from "./failure-lesson.ts";

/** No model call or automatic rule activation. Only host-proven failure→edit→pass episodes. */
export class FailureLearningService {
  constructor(private readonly deps:{state:LocalStateService;artifactStore:ArtifactStore}){}
  async recordRecovery({taskRunId}:{taskRunId:string}):Promise<Observation[]> {
    const {state,artifactStore}=this.deps;
    const task=await state.getTaskRun(taskRunId),gate=await state.getLatestQualityGateResult(taskRunId);
    if(!task||!gate||gate.status!=="passed"||!gate.validationState?.fingerprint) return [];
    const runs=await state.validationRuns.listByTaskRun(taskRunId);
    if(!runs.some(r=>r.status==="failed"&&Number.isInteger(r.exitCode)&&r.exitCode!==0))return [];
    try {await state.assertQualityGateCurrent(gate);} catch{return [];}
    const [steps,artifacts,approvals,observations]=await Promise.all([state.listStepsByTaskRun(taskRunId),state.listArtifactsByTaskRun(taskRunId),state.listApprovalsByTaskRun(taskRunId),state.listObservations({taskRunId,limit:1000})]);
    const current=selectCurrentValidationEvidence({taskRunId,runs,steps,artifacts,current:{...gate.validationState,activeMutations:0}}).runs;
    const result:Observation[]=[];
    for(const pass of current.filter(r=>r.status==="completed"&&r.exitCode===0)){
      const failure=[...runs].reverse().find(r=>r.checkerId===pass.checkerId&&r.sequence<pass.sequence&&r.status==="failed"&&
        Number.isInteger(r.exitCode)&&r.exitCode!==0&&r.artifactId&&r.startFingerprint&&r.startFingerprint===r.finishFingerprint&&
        r.startGeneration===r.finishGeneration&&steps.some(s=>s.id===r.stepId&&s.status==="failed"));
      if(!failure?.artifactId||!pass.artifactId)continue;
      const id="obs_failure_"+createHash("sha256").update(`${taskRunId}\0${failure.id}`).digest("hex");
      if(await state.observations.get(id)||observations.some(o=>observationLesson(o)?.failureRunId===failure.id))continue;
      // A later pass without an actual approved code change is not a learned correction.
      const edits=steps.filter(s=>s.kind==="edit"&&s.status==="succeeded"&&s.finishedAt&&s.finishedAt>=(failure.finishedAt??failure.startedAt)&&s.finishedAt<=pass.startedAt);
      const diffs=artifacts.filter(a=>a.kind==="diff"&&edits.some(s=>s.id===a.stepId));
      const repairs=approvals.filter(a=>(a.actionType==="file_write"||a.actionType==="file_patch")&&a.executionState==="succeeded"&&
        a.executionStartedAt&&a.executionStartedAt>=failure.startedAt&&a.executionStartedAt<=pass.startedAt);
      if(!diffs.length||!repairs.length)continue;
      const failedArtifact=artifacts.find(a=>a.id===failure.artifactId&&a.stepId===failure.stepId&&(a.kind==="test_result"||a.kind==="log"));
      if(!failedArtifact)continue;
      let output:string,patch:string;
      try{
        output=redactSecrets(await artifactStore.read({taskRunId,artifactId:failedArtifact.id,kind:failedArtifact.kind}),5000);
        patch=redactSecrets((await Promise.all(diffs.slice(-3).map(a=>artifactStore.read({taskRunId,artifactId:a.id,kind:a.kind})))).join("\n"),3500);
      }catch{continue;}
      const symptom=output.split(/\r?\n/).filter(s=>/error|exception|assert|expected|failed|failure/i.test(s)).slice(0,5).join("\n").slice(0,1200)||output.slice(-1200);
      if(!symptom.trim()||!patch.trim())continue;
      const hypothesis=redactSecrets(repairs.map(a=>a.actionSummary).join("; "),1200);
      const lesson:FailureLesson={version:1,failureRunId:failure.id,recoveryRunId:pass.id,checkerId:pass.checkerId,
        symptom,repairHypothesis:hypothesis,causeStatus:"hypothesis",patchExcerpt:patch,
        applicabilityTerms:lessonTerms(`${task.userRequest} ${symptom} ${hypothesis}`),
        evidenceArtifactIds:[failure.artifactId,pass.artifactId,...diffs.slice(-3).map(a=>a.id)]};
      // Revalidate after reading evidence. A stale/partial repair must not be promoted.
      try{await state.assertQualityGateCurrent(gate);}catch{return result;}
      result.push(await state.createObservation({id,taskRunId,threadId:task.threadId,projectKey:await deriveProjectKey({targetDir:task.targetDir}),
        source:"learner",eventType:"verified_failure_repair",signal:"repaired",summary:redactSecrets(`${symptom} Repair hypothesis: ${hypothesis}`,1600),payload:{failureLesson:lesson}}));
    }
    return result;
  }
}
