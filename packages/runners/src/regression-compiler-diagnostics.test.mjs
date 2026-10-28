import {test} from 'node:test';import assert from 'node:assert/strict';
import {regressionCompilerDiagnostics} from './regression-compiler-diagnostics.ts';
const line=(i=1,n=3,c=4,message='missing member')=>`C:/temp/Source${i}.cs(${n},${c}): error CS1061: ${message} [C:/temp/HarnessRegression.csproj]`;
test('compiler diagnostics map staged files to registered paths and deduplicate build summaries',()=>{
 const result=regressionCompilerDiagnostics(line()+'\r\n'+line(),[{path:'Candidate.cs'},{path:'tests/Verification.cs'}]);
 assert.deepEqual(result,[{code:'CS1061',message:'missing member',line:3,column:4,path:'tests/Verification.cs'}]);
});
test('compiler diagnostics reject unknown files and positions and bound all payload fields',()=>{
 const sources=[{path:'x'.repeat(241)+'.cs'},{path:'Verification.cs'}];
 assert.deepEqual(regressionCompilerDiagnostics([line(99),line(1,0),line(1,1,0),line(1,10000001),line(1,1,10000001),'Source1.cs: error CS1234: no position'].join('\n'),sources),[]);
 const result=regressionCompilerDiagnostics([line(0,1,1,'x'.repeat(500)),...Array.from({length:7},(_,i)=>line(1,i+1))].join('\n'),sources);
 assert.equal(result.length,4);assert.equal(result[0].message.length,240);assert.equal(result[0].path,undefined);
});
