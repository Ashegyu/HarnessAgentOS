import {test} from 'node:test';import assert from 'node:assert/strict';
import {remainingRepairCalls,compilerRetryEligible} from './learning-executed-repair.mjs';
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
