import {createHash} from 'node:crypto';
import type {RegressionControlEvidence} from '@harness/core';

/** Observed failure identity, not a claim about root cause. Unknown runtime output stays conservative. */
export function regressionFailureFingerprint(input:{referenceFingerprint:string;referenceIndex:number;stderr:string;compilationFailure?:RegressionControlEvidence['compilationFailure']}):string {
 const compiler=input.compilationFailure;
 // Stack paths/line numbers are execution locations, not new failure observations.
 // Preserve the exact exception type/message, including user paths and values.
 const diagnostic=compiler
  ? compiler.diagnostics.map(d=>({code:d.code,path:d.path??null,message:d.message})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : input.stderr.match(/^Unhandled exception\. ([^\r\n]{0,512})/m)?.[1]??null;
 return createHash('sha256').update(JSON.stringify({version:1,reference:input.referenceFingerprint,index:input.referenceIndex,kind:compiler?'compilation':'execution',diagnostic})).digest('hex');
}
