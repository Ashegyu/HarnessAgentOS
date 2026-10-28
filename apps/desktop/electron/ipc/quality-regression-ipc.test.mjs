import {test} from "node:test";
import assert from "node:assert/strict";
import {buildRegressionHandler} from "./quality-regression-handlers.ts";

test("regression IPC rejects malformed/unconfirmed registrations before any service work",async()=>{
  let calls=0;
  const runner={registerRegressionContract:async()=>{calls++;}};
  const h=buildRegressionHandler(runner,()=>{},"registerRegression");
  const valid={taskRunId:"task",title:"test",referenceDir:"C:/reference",sourcePaths:["Api.cs"],sharedPaths:[],verificationPaths:["Test.cs"],manualConfirmation:true};
  for(const input of [null,{},[],{...valid,manualConfirmation:false},{...valid,sourcePaths:[17]},{...valid,sharedPaths:null}])
    assert.equal((await h(input)).ok,false);
  assert.equal(calls,0);
});

test("regression IPC registration and preparation emit changes but never approve or execute",async()=>{
  const calls=[],events=[];
  const runner={registerRegressionContract:async input=>{calls.push(input);return{id:"reg"};},
    prepareRegressionCheck:async input=>{calls.push(input);return{id:"approval",status:"pending"};},
    listRegressionContracts:async input=>{calls.push(input);return[{id:"reg"}];},
    executeApproved:()=>{throw new Error("must not execute");}};
  const changed=id=>events.push(id);
  assert.equal((await buildRegressionHandler(runner,changed,"registerRegression")({taskRunId:"task",title:"test",referenceDir:"C:/reference",
    sourcePaths:["Api.cs"],sharedPaths:[],verificationPaths:["Test.cs"],manualConfirmation:true})).value.id,"reg");
  const prepare=buildRegressionHandler(runner,changed,"prepareRegression");
  assert.equal((await prepare({taskRunId:"task"})).ok,false);
  assert.equal((await prepare({taskRunId:"task",contractId:"reg"})).value.status,"pending");
  assert.equal((await buildRegressionHandler(runner,changed,"listRegressions")({taskRunId:"task"})).value.length,1);
  assert.deepEqual(events,["task","task"]);
  assert.equal(calls.length,3);
  const failed=await buildRegressionHandler({...runner,prepareRegressionCheck:async()=>{throw new Error("stale inputs");}},changed,"prepareRegression")({taskRunId:"task",contractId:"reg"});
  assert.equal(failed.ok,false);assert.match(failed.error.message,/stale/);
});

