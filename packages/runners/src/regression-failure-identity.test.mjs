import {test} from 'node:test';
import assert from 'node:assert/strict';
import {regressionFailureFingerprint as fingerprint} from './regression-failure-identity.ts';
const base={referenceFingerprint:'a'.repeat(64),referenceIndex:0,stderr:'Unhandled exception. System.Exception: expected 0, actual -17\n   at Program.Main() in C:/temp/first/Source.cs:line 20'};
test('observed regression diagnostic and failed normal control distinguish later failures',()=>{
 assert.match(fingerprint(base),/^[a-f0-9]{64}$/);
 for(const patch of [{referenceIndex:1},{referenceFingerprint:'b'.repeat(64)},{stderr:base.stderr.replace('actual -17','actual -18')}])assert.notEqual(fingerprint(base),fingerprint({...base,...patch}));
 assert.equal(fingerprint(base),fingerprint({...base,stderr:base.stderr.replace('first/Source.cs:line 20','second/Source.cs:line 99')}),'new recording paths/stack locations are not new diagnostics');
});
test('only bounded actual stderr exception headlines or host compiler diagnostics enter the identity',()=>{
 assert.equal(fingerprint({...base,stderr:'plain output 1'}),fingerprint({...base,stderr:'plain output 2'}),'unknown output is conservatively the same failure');
 const diagnostic={code:'CS1061',path:'Verification.cs',line:2,column:8,message:'member missing'};
 const a={...base,compilationFailure:{phase:'reference',exitCode:1,diagnostics:[diagnostic]}};
 assert.equal(fingerprint(a),fingerprint({...a,stderr:'another build path',compilationFailure:{...a.compilationFailure,diagnostics:[{...diagnostic,line:99,column:2}]}}));
 assert.notEqual(fingerprint(a),fingerprint({...a,compilationFailure:{...a.compilationFailure,diagnostics:[{...diagnostic,code:'CS0103'}]}}));
 assert.notEqual(fingerprint(base),fingerprint(a));
 const two={...a,compilationFailure:{...a.compilationFailure,diagnostics:[diagnostic,{code:'CS0103',message:'unknown name'}]}};
 assert.equal(fingerprint(two),fingerprint({...two,compilationFailure:{...two.compilationFailure,diagnostics:[...two.compilationFailure.diagnostics].reverse()}}),'compiler diagnostic ordering is not a new failure');
 assert.equal(fingerprint({...base,stderr:'Unhandled exception. '+ 'x'.repeat(1000)+'a'}),fingerprint({...base,stderr:'Unhandled exception. '+ 'x'.repeat(1000)+'b'}),'unbounded tails cannot manufacture a fresh failure');
});
