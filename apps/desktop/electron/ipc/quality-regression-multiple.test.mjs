import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildRegressionHandler} from './quality-regression-handlers.ts';
test('registration IPC rejects malformed additional reference lists before the runner',async()=>{
 let calls=0;const handler=buildRegressionHandler({registerRegressionContract:async()=>{calls++;return{};}},()=>{},'registerRegression');
 const base={taskRunId:'task',title:'trusted',referenceDir:'C:/reference',sourcePaths:['Candidate.cs'],sharedPaths:[],verificationPaths:['Verification.cs'],manualConfirmation:true};
 for(const additionalReferenceDirs of ['wrong',[1],[''],Array(4).fill('C:/reference')])assert.equal((await handler({...base,additionalReferenceDirs})).ok,false);
 assert.equal(calls,0);
});
