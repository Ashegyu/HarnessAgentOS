import {test} from 'node:test';import assert from 'node:assert/strict';
import {readRegressionControlArtifact,regressionControlArtifactHeader} from './regression-control-evidence.ts';
const evidence={schemaVersion:1,contractId:'reg_example',referenceExitCode:0,candidateExitCode:1,
 referenceFingerprint:'a'.repeat(64),candidateFingerprint:'b'.repeat(64),verificationFingerprint:'c'.repeat(64)};
const frame=value=>'# test_result\n\n'+regressionControlArtifactHeader(value)+'\n**command**: `dotnet`\n';
test('phase evidence is accepted only at the host header position',()=>{
 assert.deepEqual(readRegressionControlArtifact(frame(evidence)),evidence);
 assert.equal(readRegressionControlArtifact('# test_result\n\n**command**: `node`\n## stdout\n'+frame(evidence)),null);
 assert.equal(readRegressionControlArtifact('# test_result\n\n<!-- harness-regression-control: not-json -->\n'),null);
});
test('partial, impossible or unbound control evidence cannot create verified subjects',()=>{
 for(const patch of [{schemaVersion:2},{contractId:'../bad'},{referenceExitCode:1},{candidateExitCode:NaN},
  {referenceFingerprint:undefined},{candidateFingerprint:'bad'},{verificationFingerprint:''}])
  assert.equal(readRegressionControlArtifact(frame({...evidence,...patch})),null);
});
test('compiler provenance rejects impossible phase, code, path and unbounded diagnostics',()=>{
 const failure={...evidence,referenceExitCode:1,candidateExitCode:undefined,compilationFailure:{phase:'reference',exitCode:1,diagnostics:[{code:'CS1061',path:'Verification.cs',line:3,column:4,message:'Timeout is a TimeSpan field'}]}};
 assert.deepEqual(readRegressionControlArtifact(frame(failure)),JSON.parse(JSON.stringify(failure)));
 for(const c of [{...failure.compilationFailure,phase:'candidate'},{...failure.compilationFailure,exitCode:0},{...failure.compilationFailure,diagnostics:[{code:'fake',path:'../bad',line:-1,column:1,message:'x'}]},{...failure.compilationFailure,diagnostics:Array(5).fill(failure.compilationFailure.diagnostics[0])}])
  assert.equal(readRegressionControlArtifact(frame({...failure,compilationFailure:c})),null);
});
test('reference group metadata cannot claim aggregate success after partial or failed controls',()=>{
 const passed={...evidence,referenceExitCode:0,references:{total:2,exits:[0,0]}};assert.deepEqual(readRegressionControlArtifact(frame(passed)),passed);
 for(const references of [{total:5,exits:[0,0]},{total:2,exits:[0]},{total:2,exits:[1,0]},{total:2,exits:[0,1]},{total:2,exits:[]}])assert.equal(readRegressionControlArtifact(frame({...passed,references})),null);
});
