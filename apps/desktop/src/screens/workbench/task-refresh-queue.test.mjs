import { test } from "node:test";
import assert from "node:assert/strict";

const module = await import("./task-refresh-queue.ts").catch(()=>({}));
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};

test("100 pushes own one active fetch and one trailing fresh fetch",async()=>{
  assert.equal(typeof module.createTaskRefreshQueue,"function");
  const gates=[deferred(),deferred()],seen=[];let calls=0;
  const q=module.createTaskRefreshQueue({load:()=>gates[calls++].promise,ready:(id,v)=>seen.push([id,v])});
  for(let i=0;i<100;i++)q.request("a");
  assert.equal(calls,1);gates[0].resolve("old");await tick();assert.equal(calls,2);
  gates[1].resolve("fresh");await tick();assert.deepEqual(seen.at(-1),["a","fresh"]);q.dispose();
});
test("distinct tasks are bounded, failures release slots and queued work survives",async()=>{
  assert.equal(typeof module.createTaskRefreshQueue,"function");
  const gates=new Map(),seen=[];let active=0,max=0;
  const q=module.createTaskRefreshQueue({concurrency:2,load:async id=>{active++;max=Math.max(max,active);const d=deferred();gates.set(id,d);try{return await d.promise;}finally{active--;}},ready:id=>seen.push(id)});
  for(const id of ["a","b","c","d"])q.request(id);
  assert.equal(gates.size,2);gates.get("a").reject(Error("failed"));await tick();assert.ok(gates.has("c"));
  gates.get("b").resolve(1);await tick();gates.get("c").resolve(1);gates.get("d").resolve(1);await tick();
  assert.equal(max,2);assert.deepEqual(seen.sort(),["b","c","d"]);q.dispose();
});
test("disposal suppresses late publication and further queued/new work",async()=>{
  assert.equal(typeof module.createTaskRefreshQueue,"function");
  const d=deferred();let calls=0;
  const q=module.createTaskRefreshQueue({concurrency:1,load:()=>{calls++;return d.promise;},ready:()=>assert.fail("late publication")});
  q.request("a");q.request("b");q.dispose();q.request("c");d.resolve(1);await tick();assert.equal(calls,1);
  for(const concurrency of [0,-1,1.5,NaN,17])assert.throws(()=>module.createTaskRefreshQueue({concurrency,load:async()=>0,ready:()=>{}}));
});
