import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import * as evaluation from './learning-executed-repair.mjs';
import {remainingRepairCalls,compilerRetryEligible} from './learning-executed-repair.mjs';

test('a later host-proven semantic reference failure is eligible within the same second-repair budget',()=>{
 const r={repairAttempted:true,repairApprovalIds:['approved'],referenceAcceptance:{protected:false},finalControl:{failureFingerprint:'a'.repeat(64),evidence:{referenceExitCode:1,contractId:'reg_one',references:{total:2,exits:[0,1]}}}};
 assert.equal(evaluation.executionRetryEligible?.(r),true);
 for(const x of [{...r,secondaryRetryAttempted:true},{...r,repairApprovalIds:[]},{...r,referenceAcceptance:{protected:true}},{...r,finalControl:{...r.finalControl,failureFingerprint:undefined}},{...r,finalControl:{...r.finalControl,evidence:{referenceExitCode:0,candidateExitCode:1}}}])assert.equal(evaluation.executionRetryEligible?.(x),false);
});
test('compiler retry uses only the remaining equal arm budget after primary calls',()=>{
 const attempts=[{arm:'before',calls:[{stage:'initial'},{stage:'repair'},{stage:'compiler-repair'}]},{arm:'after',calls:[{stage:'initial'},{stage:'repair'}]}];
 assert.equal(remainingRepairCalls(attempts,'before'),2);assert.equal(remainingRepairCalls(attempts,'after'),3);
 attempts[0].calls.push(...Array(8).fill({stage:'repair'}));assert.equal(remainingRepairCalls(attempts,'before'),0);assert.equal(remainingRepairCalls(attempts,'after'),3);
});
test('only a compiler error in the submitted checker after its first approved patch is retryable',()=>{
 const r={repairAttempted:true,repairApprovalIds:['approval'],finalControl:{evidence:{compilationFailure:{phase:'reference',diagnostics:[{path:'Verification.cs',code:'CS1061'}]}}}};
 assert.equal(compilerRetryEligible(r),true);
 for(const x of [{...r,compilerRetryAttempted:true},{...r,repairAttempted:false},{...r,repairApprovalIds:[]},{...r,finalControl:{evidence:{}}},{...r,finalControl:{evidence:{compilationFailure:{phase:'candidate',diagnostics:[{path:'Verification.cs',code:'CS1061'}]}}}},{...r,finalControl:{evidence:{compilationFailure:{phase:'reference',diagnostics:[{path:'Candidate.cs',code:'CS1061'}]}}}}])assert.equal(compilerRetryEligible(x),false);
});
test('a validation timeout cannot drop a completed answer with frozen grading inputs',()=>{
 const folder=mkdtempSync(join(tmpdir(),'hgos-grade-timeout-'));
 try{
  writeFileSync(join(folder,'initial-candidate.cs'),'// candidate');writeFileSync(join(folder,'initial-verification.cs'),'// verification');
  const record={completed:true,folder,error:{code:'RUNNER_EXECUTION_FAILED',message:'candidate timed out'}};
  assert.equal(evaluation.shouldGradeSubmittedAnswer?.(record),true);
  assert.equal(evaluation.shouldGradeSubmittedAnswer?.({...record,completed:false}),false);
  assert.equal(evaluation.shouldGradeSubmittedAnswer?.({...record,folder:join(folder,'missing')}),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
